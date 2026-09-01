require('dotenv/config');
const { Client } = require("discord.js");
const { OpenAI } = require("openai");
const Database = require('better-sqlite3');
require('punycode/');

const { setupLinkTable, handleLinkCommand, handleAnalyzeCommand } = require('./analyze-command.js');
const { setupQuotaTable, checkAndConsumeQuota, peekQuota, limitHitMessage, isQuotaExempt, LIMITS } = require('./quota.js');

// Optional whitelist - users/roles listed here skip ALL quotas entirely
// (unlimited use, not tracked). Comma-separated Discord IDs in .env, e.g.:
//   QUOTA_WHITELIST_USERS=123456789012345678,987654321098765432
//   QUOTA_WHITELIST_ROLES=112233445566778899
// Both optional - leave unset and nobody's exempt.
const QUOTA_WHITELIST_USERS = (process.env.QUOTA_WHITELIST_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const QUOTA_WHITELIST_ROLES = (process.env.QUOTA_WHITELIST_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);
if (QUOTA_WHITELIST_USERS.length > 0) console.log(`[quota] ${QUOTA_WHITELIST_USERS.length} user(s) whitelisted from quotas.`);
if (QUOTA_WHITELIST_ROLES.length > 0) console.log(`[quota] ${QUOTA_WHITELIST_ROLES.length} role(s) whitelisted from quotas.`);
const { handleSearchCommand } = require('./search-command.js');
const { GUMY_PERSONA } = require('./gumy-persona.js');
const { buildResearcherSystemPrompt, todayDateString, isGenshinRelated, isLeakQuestion, refineSearchQueries, runMultiSearch, refineSearchQuery, getWebResearch, appendBannerLinksIfNeeded, formatSources } = require('./search-helpers.js');
const { buildGenshinDatabaseContext } = require('./genshin-data.js');

// Same tagged-log pattern as analyze-command.js / search-command.js - for
// pipeline STAGES and metadata (who, what step, timing, counts, results).
// Never logs prompt text, conversation history, or raw AI completion
// content - that stays out of the console (and any Discord-visible trace)
// even at this verbosity.
//
// createLogger() returns a per-message log() function that both prints to
// console AND collects into a trace array, so that array can be attached to
// THIS message's own reply as a visible-but-unobtrusive process log, without
// mixing entries from concurrent messages from other users.
function createLogger() {
    const trace = [];
    const log = (...args) => {
        const line = args.join(' ');
        console.log(`[chat ${new Date().toISOString().slice(11, 19)}]`, line);
        trace.push(line);
    };
    log.trace = trace;
    // Formats the collected trace as a small-text block to append to a
    // Discord reply, or '' if there's nothing to show yet.
    log.block = () => trace.length > 0 ? `\n\n${trace.map(line => `-# ${line}`).join('\n')}` : '';
    return log;
}

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database('gumy.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        profile TEXT DEFAULT '{}',
        history TEXT DEFAULT '[]',
        updated_at INTEGER DEFAULT 0
    )
`);

setupLinkTable(db);
setupQuotaTable(db);

const MAX_HISTORY = 30;
// Keep enough recent turns for follow-up questions about build analyses and
// searches. The old 4,500-character cap compacted useful details almost
// immediately after a single /analyze response.
const MAX_HISTORY_CHARS = 18000;

function getUser(userId, username) {
    let user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (user_id, username, profile, history) VALUES (?, ?, ?, ?)')
          .run(userId, username, '{}', '[]');
        user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    }
    return { ...user, profile: JSON.parse(user.profile), history: JSON.parse(user.history) };
}

// Aggregates real profile data across users so "what do you think of X" /
// "what's the vibe here" type questions can be grounded in actual community
// signal instead of Gumy just inventing generic flavor text. Cached in
// memory with a TTL since scanning the whole users table on every message
// would be wasteful - profiles don't change fast enough to need that.
let communitySnapshotCache = { text: null, builtAt: 0 };
const COMMUNITY_SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCommunitySnapshot() {
    const now = Date.now();
    if (communitySnapshotCache.text !== null && (now - communitySnapshotCache.builtAt) < COMMUNITY_SNAPSHOT_TTL_MS) {
        return communitySnapshotCache.text;
    }

    try {
        const rows = db.prepare(`
            SELECT username, profile FROM users
            WHERE profile IS NOT NULL AND profile != '{}'
            ORDER BY updated_at DESC
            LIMIT 25
        `).all();

        if (rows.length === 0) {
            communitySnapshotCache = { text: '', builtAt: now };
            return '';
        }

        const lines = rows.map(r => {
            try {
                const profile = JSON.parse(r.profile);
                const summary = Object.values(profile).filter(Boolean).join(', ').slice(0, 150);
                return summary ? `${r.username}: ${summary}` : null;
            } catch {
                return null;
            }
        }).filter(Boolean);

        const text = lines.join('\n');
        communitySnapshotCache = { text, builtAt: now };
        console.log(`[community-snapshot] Rebuilt from ${lines.length} user profile(s).`);
        return text;
    } catch (err) {
        console.error('Community snapshot query failed:', err.message);
        return communitySnapshotCache.text || '';
    }
}

function saveUser(userId, username, profile, history) {
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
    db.prepare(`
        INSERT INTO users (user_id, username, profile, history, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            profile = excluded.profile,
            history = excluded.history,
            updated_at = excluded.updated_at
    `).run(userId, username, JSON.stringify(profile), JSON.stringify(history), Date.now());
}

// Conversation persistence must not depend on profile extraction. Profile
// updates are intentionally sampled to reduce model calls; message memory is
// not. This helper is also passed to slash commands, which do not emit a
// normal Discord messageCreate event for their final replies.
function saveHistoryMessages(userId, username, messages) {
    const user = getUser(userId, username);
    for (const message of messages) {
        if (!message?.content || !['user', 'assistant'].includes(message.role)) continue;
        user.history.push({ role: message.role, content: String(message.content).slice(0, 7000) });
    }
    saveUser(userId, username, user.profile, user.history);
}

function rememberConversation(userId, username, userMessage, replyContent) {
    saveHistoryMessages(userId, username, [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: replyContent },
    ]);
}

async function compressHistoryIfNeeded(userId, username) {
    const user = getUser(userId, username);
    const totalChars = user.history.reduce((acc, m) => acc + String(m.content || '').length, 0);
    if (totalChars <= MAX_HISTORY_CHARS || user.history.length <= 6) return;

    const toCompress = user.history.slice(0, -6);
    const toKeep = user.history.slice(-6);

    try {
        const result = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                { role: 'system', content: 'Summarize this conversation history into a compact recap. Preserve: character names, worldbuilding, story elements, key facts. Be concise. Plain text only.' },
                { role: 'user', content: toCompress.map(m => `${m.role}: ${String(m.content || '').slice(0, 400)}`).join('\n') }
            ],
            max_completion_tokens: 250
        });
        const summaryText = result.choices?.[0]?.message?.content?.trim();
        if (summaryText) {
            user.history = [
                { role: 'assistant', content: `(Earlier recap: ${summaryText})` },
                ...toKeep
            ];
            saveUser(userId, username, user.profile, user.history);
            console.log(`Compressed history for ${username} (was ${totalChars} chars)`);
        }
    } catch (err) {
        console.error('History compression failed:', err.message);
    }
}

async function updateUserProfile(userId, username, newMessage, replyContent) {
    const user = getUser(userId, username);

    try {
        const profileUpdate = await openai.chat.completions.create({
            model: 'gpt-5.4-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a profiler for a Discord bot. Based on the conversation, extract what you know about this user.
Return ONLY a raw JSON object with these fields (omit if unknown):
{
  "lean": "linux | genshin | both",
  "distro": "their linux distro if mentioned",
  "ar": "their Genshin AR level if mentioned",
  "main": "their Genshin main if mentioned",
  "behavior": "good-faith | troll | power-user | casual",
  "interests": ["list", "of", "interests"],
  "facts": ["notable", "facts", "they've", "mentioned"]
}
Merge with existing profile, don't drop known info.`
                },
                {
                    role: 'user',
                    content: `Existing profile: ${JSON.stringify(user.profile)}\n\nRecent exchange:\nUser: ${newMessage}\nGumy: ${replyContent || ''}`
                }
            ],
            max_completion_tokens: 400
        });

        // fix 1: safe JSON parse - the profiler model doesn't always follow
        // "output only JSON" perfectly (wraps it in a sentence, or truncates
        // if it ran long). This is expected occasionally and handled safely:
        // on failure we just skip this one profile update, nothing bad gets
        // written to the DB. Try a regex fallback first in case the JSON is
        // in there but just wrapped in something else.
        const raw = profileUpdate.choices?.[0]?.message?.content?.trim().replace(/```json|```/g, '').trim();
        let updatedProfile = {};
        try {
            updatedProfile = JSON.parse(raw);
        } catch {
            const match = raw?.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    updatedProfile = JSON.parse(match[0]);
                } catch {
                    console.log('[profiler] Model output wasn\'t valid JSON even after extraction - skipping this profile update (not a DB issue, nothing was written):', raw);
                }
            } else {
                console.log('[profiler] Model returned no JSON object at all - skipping this profile update (not a DB issue, nothing was written):', raw);
            }
        }
        user.profile = { ...user.profile, ...updatedProfile };
    } catch (err) {
        console.error('Profile update failed:', err.message);
    }

    saveUser(userId, username, user.profile, user.history);
}

// ─── Message classifier + Web search ─────────────────────────────────────────

// Returns "search" | "genshin_build" | "story" | "normal"
async function classifyMessage(messageContent, recentHistory = []) {
    try {
        const context = recentHistory.length > 0
            ? `Recent conversation:\n${recentHistory.slice(-3).map(m => `${m.role}: ${String(m.content).slice(0, 120)}`).join('\n')}\n\n`
            : '';

        const check = await openai.chat.completions.create({
            model: 'gpt-5.6-luna',
            messages: [
                {
                    role: 'system',
                    content: `Classify this Discord message. Reply ONLY with one word: "search", "genshin_build", "story", or "normal".

"genshin_build" — SPECIFICALLY about a Genshin Impact character's build, kit, or team:
- "is X's build good", "rate my Y build", "what should I run on Z"
- artifact sets, weapons, substats, or team comps for a specific character
- "should I pull X", character tier/viability questions
This gets extra scrutiny over plain "search" because getting it wrong (outdated sets/weapons, wrong numbers) is embarrassing to say out loud to viewers - use this category whenever the question is this specific, not just "normal".

"search" — needs a web lookup but isn't a Genshin build question:
- current events, patch notes, recent game updates (non-build), prices, news
- anything about the CURRENT state of something that changes over time: software/driver versions, product specs, "is X still true/available", current standings/rankings, etc.
- Honkai / ZZZ builds, or general Genshin news/lore that isn't about a specific character's build
- IMPORTANT: the message names a SPECIFIC term, mechanic, system, item, or proper noun (especially Genshin-flavored ones) that you are not fully, confidently certain is real/well-established. Could be a new patch addition, an obscure system, a mistranslation, or something made up entirely - you genuinely don't know without checking. Route these to "search" rather than guessing "normal". A wasted search costs nothing (people can see when Gumy searched vs didn't) - a confidently wrong answer about something unverified is a real failure, and this is the single most common way this classifier gets it wrong. When in doubt about whether you actually KNOW a named thing vs merely recognize the shape of the words, default to "search".

"story" — creative/narrative content:
- collaborative fiction, roleplay, world-building
- continuing a story or adding to a shared narrative
- describing fictional characters, kingdoms, events, lore
- short replies like "again", "continue", "go on", "then what" if the recent conversation is a story

"normal" — everything else, ONLY when you're genuinely confident you already know the answer well:
- casual chat, opinions, math, coding help, jokes, general conversation
- well-established knowledge you're highly confident about (how photosynthesis works, capital of France, long-standing Genshin mechanics like Vaporize/Overloaded that have existed for years) - not "sounds like the kind of thing that might be well-established"`
                },
                { role: 'user', content: `${context}New message: ${messageContent}` }
            ],
            max_completion_tokens: 5
        });
        const answer = check.choices?.[0]?.message?.content?.trim().toLowerCase();
        if (answer === 'search' || answer === 'story' || answer === 'genshin_build') return answer;
        return 'normal';
    } catch (err) {
        console.error('Classify failed:', err.message);
        return 'normal';
    }
}

// Genshin build questions get several targeted searches instead of one
// generic one - current meta, artifact sets specifically, and team comps -
// same approach as /analyze. Wrong or stale build info here is the kind of
// thing that's actually embarrassing to say out loud on stream, so it's
// worth the extra calls. Runs in parallel to keep latency reasonable.
async function getGenshinBuildResearch(messageContent) {
    const queries = [
        { label: 'current meta / tier info', prompt: `Answer this Genshin Impact question with current, up-to-date information: ${messageContent}` },
        { label: 'artifact sets & weapons', prompt: `For the Genshin Impact context in this question, what are the current best artifact sets and weapons specifically? Question: ${messageContent}` },
        { label: 'team comps', prompt: `For the Genshin Impact context in this question, what are the current best team compositions? Question: ${messageContent}` },
    ];

    console.log('[genshin_build] Running', queries.length, 'targeted searches...');
    const results = await Promise.all(queries.map(async q => {
        try {
            const result = await getWebResearch(
                q.prompt,
                openai,
                'Search the web for current, accurate Genshin Impact information. Be concise and factual - 2-4 sentences. Watch for outdated guides written for an older patch, and don\'t present them as current meta. Cite each factual claim using the sources you found.',
                { genshinTopic: true, maxOutputTokens: 900 }
            );
            return { label: q.label, ...result };
        } catch (err) {
            console.error(`[genshin_build] Search failed (${q.label}):`, err.message);
            return { label: q.label, text: null, sources: [] };
        }
    }));

    const combinedText = results.filter(r => r.text).map(r => `${r.label}: ${r.text}`).join('\n\n');
    const seenUrls = new Set();
    const sources = results.flatMap(r => r.sources).filter(s => (seenUrls.has(s.url) ? false : (seenUrls.add(s.url), true)));

    console.log(`[genshin_build] Done - ${combinedText.length} chars combined, ${sources.length} unique source(s).`);
    return { text: combinedText || null, sources };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMentions(content, guild) {
    return content.replace(/<@!?(\d+)>/g, (match, id) => {
        const member = guild.members.cache.get(id);
        if (member) {
            getUser(id, member.user.username);
            return `@${member.user.username}`;
        } else {
            getUser(id, `unknown_${id}`);
            return match;
        }
    });
}

// Reverse of resolveMentions: the model writes plain "@username" text to
// address someone (since it doesn't know Discord IDs), we convert that back
// into a real <@id> mention before sending so it actually pings and renders
// as a clickable mention. Best-effort - only replaces names found in the
// guild's cached member list.
function resolveOutgoingMentions(content, guild) {
    if (!guild) return content;
    return content.replace(/@(\w+)/g, (match, name) => {
        const member = guild.members.cache.find(m =>
            m.user.username.toLowerCase() === name.toLowerCase() ||
            m.displayName.toLowerCase() === name.toLowerCase()
        );
        return member ? `<@${member.id}>` : match;
    });
}

function splitMessage(text, max = 2000) {
    const lines = text.split('\n');
    let current = '';
    const chunks = [];

    for (const line of lines) {
        if ((current + '\n' + line).length > max && current.length > 0) {
            chunks.push(current.trim());
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current.trim()) chunks.push(current.trim());

    const result = [];
    for (const chunk of chunks) {
        if (chunk.length <= max) {
            result.push(chunk);
        } else {
            let i = 0;
            while (i < chunk.length) {
                result.push(chunk.slice(i, i + max));
                i += max;
            }
        }
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: ["Guilds", 'GuildMembers', 'GuildMessages', 'MessageContent']
});

client.on("ready", () => {
  console.log('The bot is online! Hooray skibidi skibidi yessirrr');
});

const IGNORE_PREFIX = "!";
// Home channel(s) where Gumy answers EVERY message without being pinged.
// Comma-separated Discord channel IDs in .env (HOME_CHANNEL_IDS=...). In any
// other channel, Gumy only responds when @mentioned. Leave unset and Gumy
// only ever answers when pinged.
const CHANNELS = (process.env.HOME_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Check if OPENAI_KEY environment variable is set and not empty
if (!process.env.OPENAI_KEY || process.env.OPENAI_KEY.trim() === "") {
  console.error("OpenAI API key is missing or empty. Please set the OPENAI_KEY environment variable.");
  process.exit(1); // Exit the process with an error
} else {
  console.log("OpenAI API key is loaded");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ─── Message handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;

    const isMentioned = message.mentions.users.has(client.user.id);
    const isHomeChannel = CHANNELS.includes(message.channelId);
    const isCrossChannelPing = !isHomeChannel && isMentioned;

    if (!isHomeChannel && !isMentioned) return;

    // Declared here (not inside try{}) specifically so they're also
    // reachable from the catch block below - const/let inside try{} is NOT
    // visible in the paired catch{}, different block scope. Both log and
    // userId get referenced there.
    const log = createLogger();
    const userId = message.author.id;
    const username = message.author.username;

    await message.channel.sendTyping();

    // fix 4: always clear typing interval with finally
    const sendTypingInterval = setInterval(() => {
        message.channel.sendTyping();
    }, 5000);

    try {
        // ── Load user from DB ────────────────────────────────────────────────
        log(`Message received from ${username} in #${message.channel.name}`);
        const user = getUser(userId, username);
        log(`DB loaded for ${username} - ${user.history.length} history entries, ${Object.keys(user.profile).length} profile field(s)`);

        const profileSummary = Object.keys(user.profile).length > 0
            ? `\nWhat you know about this user:\n${JSON.stringify(user.profile, null, 2)}`
            : '';

        const communitySnapshot = getCommunitySnapshot();
        const communityContext = communitySnapshot
            ? `\n\nReal aggregated snippets from this community's member profiles (grounded data, not vibes - draw on this naturally for "what's the vibe here" / "what do people like" / self-reflective questions about the community, but don't dump it verbatim or read it out as a list):\n${communitySnapshot}`
            : '';

        // fix 2: only use last 10 of DB history for long-term memory,
        // channel messages handle immediate context — no overlap
        const userHistory = user.history.slice(-10).map(h => ({ role: h.role, content: h.content }));
        // ────────────────────────────────────────────────────────────────────

        if (isCrossChannelPing) {
            console.log(`[cross-channel ping] ${username} pinged Gumy in #${message.channel.name} (${message.channelId})`);
        }

        // ── Reply-chain awareness ───────────────────────────────────────────
        // The 10-message rolling window below can miss what's actually being
        // talked about if someone replies to something further back (or to a
        // system message, e.g. a member-join notice). Always fetch the exact
        // message being replied to, regardless of whether it's still in that
        // window, so Gumy never silently loses the actual context.
        let replyContext = '';
        if (message.reference) {
            try {
                const refMsg = await message.fetchReference();
                const refUsername = refMsg.author.username.replace(/\s+/g, '_').replace(/[^\w\s]/gi, '');
                let refContent = refMsg.content && refMsg.content.trim() ? refMsg.content : '';

                // .content only covers plain text - if the referenced message
                // is embed-only (e.g. an older bot reply built with embeds),
                // pull readable text out of the embed instead of going blind.
                if (!refContent && refMsg.embeds && refMsg.embeds.length > 0) {
                    refContent = refMsg.embeds.map(e => {
                        const parts = [];
                        if (e.title) parts.push(e.title);
                        if (e.description) parts.push(e.description);
                        if (e.fields) parts.push(...e.fields.map(f => `${f.name}: ${f.value}`));
                        return parts.join('\n');
                    }).join('\n\n').trim();
                }

                if (!refContent) {
                    refContent = refMsg.system ? `[system message: ${refUsername} joined the server]` : '[message has no text content]';
                }

                replyContext = `\n\nIMPORTANT - this message is a REPLY to an earlier message. Treat that as the real context for what's being asked, even if it's not in the recent channel history below:\nReplied-to message, from ${refUsername} (mention as <@${refMsg.author.id}>): "${refContent.slice(0, 800)}"`;
                console.log(`[reply-chain] ${username} replied to ${refUsername}: "${refContent.slice(0, 80)}"`);
            } catch (err) {
                console.error('Failed to fetch replied-to message:', err.message);
            }
        }
        // ────────────────────────────────────────────────────────────────────

        // ── Classify + Web search ────────────────────────────────────────────
        const resolvedContent = resolveMentions(message.content, message.guild);
        const messageType = await classifyMessage(resolvedContent, userHistory);
        log(`Classified as: ${messageType}`);
        const genshinRelated = isGenshinRelated(resolvedContent);
        // Not gated on genshinRelated (keyword-only: "genshin"/"hoyoverse"/etc.) -
        // buildGenshinDatabaseContext does its own character-name matching against
        // genshin-db and safely returns '' when nothing matches, so gating it here
        // just blocked plain "who is odette"-style messages that never say "genshin".
        const genshinDatabaseContext = buildGenshinDatabaseContext(resolvedContent);

        let webContext = '';
        let webSources = [];
        let quotaCapped = false; // true when a search-needing message got downgraded due to hitting the daily chat_search limit
        const needsSearch = messageType === 'search' || messageType === 'genshin_build';
        const memberRoleIds = message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : [];
        const exempt = isQuotaExempt(userId, memberRoleIds, QUOTA_WHITELIST_USERS, QUOTA_WHITELIST_ROLES);

        // Separate hard cap on organic non-search chat: 10 normal replies/day,
        // 10 story (RP) replies/day, each its own pool. Unlike chat_search
        // (which downgrades to a cheaper fallback model when exhausted),
        // there's no cheaper tier below nano for these - so hitting this one
        // blocks the reply outright, with the same loud, un-diminished
        // messaging as /analyze and /search use when their quotas are hit.
        if (!exempt && !needsSearch) {
            const quotaType = messageType === 'story' ? 'story_message' : 'normal_message';
            const msgQuota = checkAndConsumeQuota(db, userId, quotaType);
            if (!msgQuota.allowed) {
                log(`${quotaType} quota exceeded (${msgQuota.used}/${msgQuota.limit}) - blocking reply.`);
                await message.reply({ content: `<@${userId}> ${limitHitMessage(quotaType, msgQuota)}${log.block()}`, allowedMentions: { repliedUser: true } });
                return;
            }
        }

        const searchQuota = (needsSearch && !exempt) ? checkAndConsumeQuota(db, userId, 'chat_search') : null;
        if (exempt && needsSearch) log(`${username} is quota-exempt (whitelisted) - search proceeding uncapped.`);

        if (needsSearch && searchQuota && !searchQuota.allowed) {
            quotaCapped = true;
            log(`Chat search quota exceeded (${searchQuota.used}/${searchQuota.limit}) - skipping search, falling back to nano.`);
        } else if (messageType === 'search') {
            try {
                const refinedQueries = await refineSearchQueries(resolvedContent, openai);
                log(`Web search - refined into ${refinedQueries.length} quer${refinedQueries.length > 1 ? 'ies' : 'y'}: ${refinedQueries.map(q => `"${q}"`).join(', ')}`);
                log(searchQuota ? `Chat search quota: ${searchQuota.used}/${searchQuota.limit} used today` : 'Chat search quota: exempt (whitelisted)');
                const searchResult = await runMultiSearch(refinedQueries, openai, { genshinTopic: genshinRelated, allowLeakSources: genshinRelated && isLeakQuestion(resolvedContent) });
                webSources = searchResult.sources;
                log(`Web search done - ${searchResult.text ? 'got evidence' : 'no evidence returned'}, ${searchResult.sources.length} source(s)`);
                if (searchResult.text) {
                    webContext = `\n\nToday's date is ${todayDateString()}. The following is web research gathered specifically for this message - treat it as supporting evidence, not settled truth. Evaluate its relevance, recency, and consistency yourself: don't repeat a claim that reads outdated, contradicts itself, or isn't actually backed by this text. If the "evidence" below is actually an old, undated, or unrelated page (e.g. an unrelated business's marketing PDF that just happens to mention a keyword), don't present it as an answer - say plainly that a current source wasn't found. Don't invent or guess anything beyond it, and don't state specifics (version numbers, names, dates) unless they're actually in here.${searchResult.queryCount > 1 ? ' IMPORTANT: the original message asked MULTIPLE distinct questions, and this evidence covers each one separately (marked by which query it answers) - make sure your reply actually addresses every question asked, don\'t just answer one and drop the rest.' : ''}\n\n${searchResult.text}`;
                    if (searchResult.sources.length > 0) {
                        webContext += `\n\nIf natural, mention where this came from (e.g. "per ${searchResult.sources[0].url}") rather than stating it as if you just knew it. Sources: ${searchResult.sources.slice(0, 3).map(s => s.url).join(', ')}`;
                    } else {
                        webContext += `\n\nNo confirmed current sources came back with this search. IMPORTANT: this does NOT mean you should refuse to answer or tell the person to go verify it themselves and stop there - that's not helpful, it's just offloading the work back onto them. Instead: give your best general answer using what you do know, clearly hedge the specific/current details you can't confirm (e.g. "not sure of the exact current banner, but..."), and always point them to somewhere they can check in one click - never end without giving them something actionable.`;
                    }
                }
            } catch (err) {
                console.error('Web search pipeline error:', err.message);
            }
        } else if (messageType === 'genshin_build') {
            try {
                const refinedQuery = await refineSearchQuery(resolvedContent, openai);
                log(`Genshin build research - refined query: "${refinedQuery}"`);
                log(searchQuota ? `Chat search quota: ${searchQuota.used}/${searchQuota.limit} used today` : 'Chat search quota: exempt (whitelisted)');
                const research = await getGenshinBuildResearch(refinedQuery);
                webSources = research.sources;
                log(`Genshin build research done - ${research.text ? 'got evidence' : 'no evidence returned'}, ${research.sources.length} source(s)`);
                if (research.text) {
                    webContext = `\n\nToday's date is ${todayDateString()}. The following is live, multi-angle web research on this build/character gathered specifically just now - treat it as supporting evidence, not settled truth, and weigh it over your own training data (especially for recently released characters, sets, or weapons your training may not cover). Evaluate recency and consistency yourself: if parts of this look outdated, conflicting, thin, or based on an unrelated/irrelevant page, say so rather than presenting it with full confidence.\n\n${research.text}`;
                    if (research.sources.length > 0) {
                        webContext += `\n\nIf it's natural to do so, you can mention where this came from, e.g. one or two of: ${research.sources.slice(0, 3).map(s => s.url).join(', ')}`;
                    }
                }
            } catch (err) {
                console.error('Genshin build research pipeline error:', err.message);
            }
        }
        // ────────────────────────────────────────────────────────────────────

        let conversation = [];
        conversation.push({
            role: 'system',
            content: `
        ${GUMY_PERSONA}

        Addressing people:
        - you know who's currently talking to you: it's ${username} - work @${username} naturally into every single reply (it'll resolve to a real mention automatically), even short ones. Not just when it "matters" - always, every message, no exceptions.
        - if a message replies to someone else, or asks you to address/welcome/reply to a specific person, use that person's name/mention exactly as given in the context below - don't ignore it just because it's not in the recent chat log
        - beyond the current speaker, only @mention OTHER people when it actually matters (welcoming them, directly answering them, correcting them) - don't tag random third parties for no reason
        ${profileSummary}${communityContext}${webContext}${genshinDatabaseContext}${replyContext}${isCrossChannelPing ? `\n\n        Context: You were pinged in #${message.channel.name}, which is outside your home channel. This is a one-off ping — keep it brief and to the point. Don't make a big deal of it.` : ''}${quotaCapped ? `\n\n        IMPORTANT: this message would normally get a web search, but the daily search-message quota is used up for this user (that's a real, intentional limit, not a malfunction). You are running on a lighter fallback model right now and have NO web access for this reply - don't pretend to search, don't state anything as "current" or "verified," and be upfront that you're answering from general knowledge only this time because the search quota's tapped out for today.` : ''}
        `
        });

        // Long-term memory from DB
        conversation.push(...userHistory);

        // Immediate channel context
        // Story turns tend to run much longer than normal chat, so a smaller
        // window here is one of the biggest real token-cost levers for RP -
        // narrative continuity mostly comes from the last few exchanges anyway.
        let prevMessages = await message.channel.messages.fetch({ limit: messageType === 'story' ? 6 : 10 });
        prevMessages.reverse();

        prevMessages.forEach((msg) => {
            if (msg.author.bot && msg.author.id !== client.user.id) return;
            if (msg.content.startsWith(IGNORE_PREFIX)) return;

            const msgUsername = msg.author.username.replace(/\s+/g, '_').replace(/[^\w\s]/gi, '');
            const contentParts = [];

            if (msg.content && msg.content.trim()) {
                contentParts.push({ type: 'text', text: msg.content });
            }

            msg.attachments.forEach((attachment) => {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: attachment.url }
                    });
                }
            });

            if (contentParts.length === 0) return;

            if (msg.author.id === client.user.id) {
                conversation.push({ role: 'assistant', name: msgUsername, content: msg.content || '' });
                return;
            }

            conversation.push({ role: 'user', name: msgUsername, content: contentParts });
        });

        // route model: story OR quota-capped → nano (cheap), everything else → luna
        const isStory = messageType === 'story';
        const useNanoFallback = isStory || quotaCapped;
        log(`Generating reply via ${useNanoFallback ? 'gpt-5.4-nano' : 'gpt-5.6-luna'}${quotaCapped ? ' (quota fallback)' : ''}...`);
        const response = await openai.chat.completions.create({
            model: useNanoFallback ? 'gpt-5.4-nano' : 'gpt-5.6-luna',
            messages: conversation,
            // Story replies capped noticeably tighter than normal chat - RP
            // turns adding up over a long session is the real cost driver,
            // and a solid paragraph or two per turn is plenty for a back-
            // and-forth format anyway. This is the "message limit" fallback,
            // stacked on top of the smaller context window above.
            max_completion_tokens: isStory ? 700 : 2000
        });

        log(`Response received - finish_reason: ${response.choices?.[0]?.finish_reason ?? 'unknown'}, tokens: ${response.usage?.total_tokens ?? '?'} (${response.usage?.completion_tokens ?? '?'} completion)`);

        let content;
        if (response.choices && response.choices.length > 0 && response.choices[0].message) {
            content = response.choices[0].message.content;
        } else {
            console.error("Response data or choices are missing or empty.");
            message.reply({ content: `<@${userId}> the model didn't send anything back that time - not me being dumb, that's a real API hiccup on OpenAI's end. Try again in a sec.${log.block()}`, allowedMentions: { repliedUser: true } });
            return;
        }

        if (!content || content.trim() === '') {
            console.error("Model returned empty content — likely all tokens used for reasoning.");
            message.reply({ content: `<@${userId}> I burned through my whole response budget on internal reasoning and had nothing left to actually say - genuine bug, not me ignoring you. Try rephrasing shorter, or just ask again.${log.block()}`, allowedMentions: { repliedUser: true } });
            return;
        }

        content = resolveOutgoingMentions(content, message.guild);

        // Hard guarantee, not just a prompt instruction: every reply must
        // visibly @mention the person Gumy is replying to, in the message
        // text itself (not just Discord's reply-ping). If the model didn't
        // naturally work one in, prepend it rather than relying on it
        // remembering every single time.
        const authorMentionTag = `<@${userId}>`;
        if (!content.includes(authorMentionTag)) {
            content = `${authorMentionTag} ${content}`;
        }

        // Hard guarantee, same pattern as the mention above: for Genshin
        // banner questions specifically, always append real, stable links
        // to check current banners - regardless of whether the search
        // succeeded or the model handled uncertainty well. This is the fix
        // for Gumy telling someone to go verify it themselves and stopping
        // there instead of giving them something to actually click.
        if (messageType === 'search') {
            content = appendBannerLinksIfNeeded(content, resolvedContent);
        }

        content += formatSources(webSources);

        // Loud and un-diminished on purpose - unlike the trace block below
        // (small-text, easy to skim past), hitting a quota needs to be
        // impossible to miss so it never reads as "Gumy got dumb."
        if (quotaCapped) {
            content += `\n\n**This reply skipped web search - today's search-message limit is used up (${searchQuota.used}/${searchQuota.limit}).** Resets at midnight UTC. Running on a lighter model for this one, no live info this time.`;
        }

        // Attach the same non-sensitive pipeline trace already going to
        // console (stage names, classification, refined query text,
        // source/token counts) directly to the reply, so it's visible to
        // whoever's watching - not just in the server logs. Never includes
        // prompt or completion content. Small-text markdown keeps it from
        // dominating the actual answer.
        if (log.trace.length > 0) {
            content += log.block();
        }

        const parts = splitMessage(content);
        await message.reply({ content: parts[0], allowedMentions: { repliedUser: true } });
        for (let i = 1; i < parts.length; i++) {
            await message.channel.send(parts[i]);
        }
        log(`Reply sent to ${username} - ${content.length} chars${parts.length > 1 ? ` across ${parts.length} messages` : ''}`);

        // Always save the full conversational turn before any optional,
        // asynchronous profile work. This is what lets a follow-up such as
        // "what did my Ororon need again?" see the prior analysis.
        rememberConversation(userId, username, message.content, content);
        log(`Saved conversation turn for ${username}.`);

        // Profile extraction remains sampled to limit API calls, but it no
        // longer controls whether the actual conversation is remembered.
        if (Math.random() < 0.3) {
            log(`Updating profile for ${username}...`);
            updateUserProfile(userId, username, message.content, content).catch(console.error);
        }

        // silently compress history in background if it's getting bloated
        compressHistoryIfNeeded(userId, username).catch(console.error);

    } catch (error) {
        let status = null;
        if (error.response) {
            status = error.response.status;
            console.error('OpenAI API Error:', error.response.status, error.response.data);
        } else {
            console.error('OpenAI Error:', error);
        }

        let explanation;
        if (status === 429) {
            explanation = "OpenAI's rate-limiting me right now (too many requests too fast) - not a Gumy problem, just traffic. Give it a few seconds.";
        } else if (status === 401 || status === 403) {
            explanation = "the API key/auth is broken on the backend - that's on whoever runs me, not something you did. Flag it to lefye.";
        } else if (status >= 500) {
            explanation = "OpenAI's servers are having a moment on their end, not mine. Try again shortly.";
        } else if (error.code === 'ECONNABORTED' || error.name === 'AbortError' || /timeout/i.test(error.message || '')) {
            explanation = "that request timed out - network hiccup, not me being slow to think. Try again.";
        } else {
            explanation = "hit a real error talking to the model - not a 'Gumy is dumb' thing, an actual backend failure. Try again in a moment.";
        }
        message.reply({ content: `<@${userId}> ${explanation}${log.block()}`, allowedMentions: { repliedUser: true } });
    } finally {
        // fix 4: always runs, even if something crashes above
        clearInterval(sendTypingInterval);
    }
});

// ─── Slash commands ───────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
    if (interaction.isCommand()) {
        if (interaction.commandName === 'skibidi') {
            interaction.reply("Toilet! Sussy baka grimace shake ohio rizzler sigma Skibidi Toilet! :cry:")
        } else if (interaction.commandName === 'link') {
            handleLinkCommand(interaction, { db }).catch(err => {
                console.error('/link failed:', err);
                const msg = `That broke on the backend (${err.message || 'unknown error'}) - real bug, not you doing anything wrong. Try again in a moment.`;
                interaction.replied || interaction.deferred
                    ? interaction.editReply(msg).catch(() => {})
                    : interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
            });
        } else if (interaction.commandName === 'analyze') {
            const interactionRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
            const exempt = isQuotaExempt(interaction.user.id, interactionRoleIds, QUOTA_WHITELIST_USERS, QUOTA_WHITELIST_ROLES);
            if (!exempt) {
                const quota = checkAndConsumeQuota(db, interaction.user.id, 'analyze');
                if (!quota.allowed) {
                    interaction.reply({ content: `<@${interaction.user.id}> ${limitHitMessage('analyze', quota)}` });
                    return;
                }
            }
            handleAnalyzeCommand(interaction, { db, openai, getUser, saveHistoryMessages }).catch(err => {
                console.error('/analyze failed:', err);
                const msg = `The build analysis hit a real backend error (${err.message || 'unknown error'}) - could be Enka Network, the image renderer, or the AI backend itself, not a "couldn't figure out your build" thing. Try again in a moment.`;
                interaction.replied || interaction.deferred
                    ? interaction.editReply(msg).catch(() => {})
                    : interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
            });
        } else if (interaction.commandName === 'search') {
            const interactionRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
            const exempt = isQuotaExempt(interaction.user.id, interactionRoleIds, QUOTA_WHITELIST_USERS, QUOTA_WHITELIST_ROLES);
            if (!exempt) {
                const quota = checkAndConsumeQuota(db, interaction.user.id, 'search_command');
                if (!quota.allowed) {
                    interaction.reply({ content: `<@${interaction.user.id}> ${limitHitMessage('search_command', quota)}` });
                    return;
                }
            }
            handleSearchCommand(interaction, { openai, rememberConversation }).catch(err => {
                console.error('/search failed:', err);
                const msg = `The search pipeline hit a real backend error (${err.message || 'unknown error'}) - not a "couldn't find it" thing, an actual failure. Try again in a moment.`;
                interaction.replied || interaction.deferred
                    ? interaction.editReply(msg).catch(() => {})
                    : interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
            });
        } else if (interaction.commandName === 'quota') {
            const interactionRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
            const exempt = isQuotaExempt(interaction.user.id, interactionRoleIds, QUOTA_WHITELIST_USERS, QUOTA_WHITELIST_ROLES);

            if (exempt) {
                interaction.reply({ content: `You're whitelisted; no daily limits apply to you.`, ephemeral: true });
                return;
            }

            const analyzeQ = peekQuota(db, interaction.user.id, 'analyze');
            const searchQ = peekQuota(db, interaction.user.id, 'search_command');
            const chatQ = peekQuota(db, interaction.user.id, 'chat_search');
            const normalQ = peekQuota(db, interaction.user.id, 'normal_message');
            const storyQ = peekQuota(db, interaction.user.id, 'story_message');

            interaction.reply({
                content: [
                    `**Your daily usage** (resets midnight UTC):`,
                    `\`/analyze\`: ${analyzeQ.used}/${analyzeQ.limit} used (${analyzeQ.remaining} left)`,
                    `\`/search\`: ${searchQ.used}/${searchQ.limit} used (${searchQ.remaining} left)`,
                    `Search-triggering chat messages: ${chatQ.used}/${chatQ.limit} used (${chatQ.remaining} left)`,
                    `Normal chat messages: ${normalQ.used}/${normalQ.limit} used (${normalQ.remaining} left)`,
                    `Story/RP chat messages: ${storyQ.used}/${storyQ.limit} used (${storyQ.remaining} left)`,
                ].join('\n'),
                ephemeral: true
            });
        }
    }
});

client.login(process.env.TOKEN);