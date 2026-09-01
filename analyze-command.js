const { StringSelectMenuBuilder, ActionRowBuilder, AttachmentBuilder, ComponentType } = require('discord.js');
const { fetchEnkaProfile } = require('./enka.js');
const { GUMY_PERSONA } = require('./gumy-persona.js');
const { getWebResearch, todayDateString } = require('./search-helpers.js');
const { getArtifactSetBonuses } = require('./genshin-data.js');
const { getAkashaCalculationsForUser, summarizeAkashaCharacter, refreshAkashaUser } = require('./akasha.js');
const { getCachedImageDataUrl, getCachedImageBuffer } = require('./image-cache.js');

// Per-invocation logger (not a single global one) - /analyze can run
// concurrently for different users, and a shared trace array would mix
// their entries together. Mirrors the same pattern in index.js. Each
// character's own research also gets its OWN logger (see runAnalysis) so
// its trace can ride along on that specific character's reply message.
function createLogger() {
    const trace = [];
    const log = (...args) => {
        const line = args.join(' ');
        console.log(`[analyze ${new Date().toISOString().slice(11, 19)}]`, line);
        trace.push(line);
    };
    log.trace = trace;
    log.block = () => trace.length > 0 ? `\n\n${trace.map(l => `-# ${l}`).join('\n')}` : '';
    return log;
}

// Defense against any enka-network-api object leaking through the summary
// (they carry a circular back-reference to the EnkaClient). Strips it
// instead of crashing the whole command.
function safeStringify(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
        if (key === 'enka' || key === 'cachedAssetsManager' || key === '_tasks') return undefined;
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
        }
        return value;
    }, 2);
}

// ─── DB: Discord user <-> Genshin UID links ────────────────────────────────

function setupLinkTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS uid_links (
            user_id TEXT PRIMARY KEY,
            uid TEXT NOT NULL
        )
    `);
}

function getLinkedUid(db, userId) {
    const row = db.prepare('SELECT uid FROM uid_links WHERE user_id = ?').get(userId);
    return row ? row.uid : null;
}

function setLinkedUid(db, userId, uid) {
    db.prepare(`
        INSERT INTO uid_links (user_id, uid) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET uid = excluded.uid
    `).run(userId, uid);
}

// ─── /link ──────────────────────────────────────────────────────────────────

async function handleLinkCommand(interaction, { db }) {
    const log = createLogger();
    const uid = interaction.options.getString('uid', true).trim();
    log(`/link from ${interaction.user.tag} -> uid ${uid}`);
    if (!/^\d{9,10}$/.test(uid)) {
        return interaction.reply({ content: `That doesn't look like a valid Genshin UID (9-10 digits).${log.block()}`, ephemeral: true });
    }
    setLinkedUid(db, interaction.user.id, uid);
    return interaction.reply({ content: `Linked your Discord account to UID \`${uid}\`. Make sure your in-game Character Showcase includes the builds you want analyzed.${log.block()}`, ephemeral: true });
}

// ─── /analyze ───────────────────────────────────────────────────────────────

async function resolveUid(interaction, db) {
    const uidOption = interaction.options.getString('uid');
    if (uidOption) return uidOption.trim();

    const userOption = interaction.options.getUser('user');
    const targetId = userOption ? userOption.id : interaction.user.id;

    const linked = getLinkedUid(db, targetId);
    if (linked) return linked;

    if (userOption) return null; // can't resolve someone else's UID without a link
    return null;
}

// Live web research on current build meta for this character, using the
// same gpt-5.6-sol search model used elsewhere in Gumy. This exists
// specifically so Gumy doesn't guess/hallucinate about recently released
// characters, sets, or weapons it wasn't trained on - it checks.
async function getBuildResearchContext(characterName, openai, log) {
    log(`Researching current meta for ${characterName} via web search...`);
    try {
        const { text, sources } = await getWebResearch(
            `What are the current best artifact sets, weapons, and team compositions for the Genshin Impact character ${characterName}?`,
            openai,
            'You are researching current Genshin Impact character build meta. Be concise: 4-6 sentences covering best artifact sets, best weapons, and team archetypes. Watch specifically for guides written for an older patch and don\'t present them as current. Cite each factual claim using the sources you found.',
            { genshinTopic: true, maxOutputTokens: 1000 }
        );
        log(`Meta research for ${characterName} done - ${text ? text.length : 0} chars, ${sources.length} source(s).`);
        return { text, sources };
    } catch (err) {
        console.error(`[analyze] Meta research failed for ${characterName}:`, err.message);
        log(`Meta research failed: ${err.message}`);
        return { text: null, sources: [] };
    }
}

// Separate, focused search for what the character's EQUIPPED sets actually
// do mechanically (2pc/4pc bonuses). Kept separate from the meta research
// call above so it can be shown as its own clearly-labeled field, rather
// than buried inside general advice prose.
async function getSetBonusResearch(setNames, openai, log) {
    const uniqueSets = [...new Set(setNames.filter(Boolean))];
    if (uniqueSets.length === 0) return { text: null, sources: [] };

    log(`Researching set bonus text for: ${uniqueSets.join(', ')}...`);
    const local = getArtifactSetBonuses(uniqueSets);
    if (local.text && local.missing.length === 0) {
        log(`Set bonus data found locally via ${local.sourceLabel}.`);
        return { text: local.text, sources: [], localSource: local.sourceLabel };
    }
    try {
        const { text, sources } = await getWebResearch(
            `What are the 2-piece and 4-piece set bonuses for these Genshin Impact artifact sets: ${local.missing.join(', ')}?`,
            openai,
            'You are looking up exact Genshin Impact artifact set bonuses. Confirm the current, correct 2-piece and 4-piece effects. Format as one short line per set: "Set Name: 2pc - ... | 4pc - ...". Be precise and concise, no extra commentary. Cite each factual claim using the sources you found.',
            { genshinTopic: true, maxOutputTokens: 900 }
        );
        const combinedText = [local.text, text].filter(Boolean).join('\n');
        log(`Set bonus research done - ${sources.length} source(s), ${local.text ? 'plus local database data' : 'no local database match'}.`);
        return { text: combinedText || null, sources, localSource: local.sourceLabel };
    } catch (err) {
        console.error('[analyze] Set bonus research failed:', err.message);
        log(`Set bonus research failed: ${err.message}`);
        return { text: local.text, sources: [], localSource: local.sourceLabel };
    }
}

// /analyze pulls a wider slice of DB memory (20 messages) than regular chat
// does (10), and only ever for the person who ran the command - this is
// their own history, never another user's, so the analysis can be
// personalized (e.g. "you mentioned going for an EM build earlier").
function buildUserContextBlock(getUser, discordUserId, discordUsername) {
    if (!getUser) return '';
    try {
        const user = getUser(discordUserId, discordUsername);
        const profileText = user.profile && Object.keys(user.profile).length > 0
            ? `\nWhat Gumy knows about ${discordUsername} from past chats: ${JSON.stringify(user.profile)}`
            : '';
        const recent = (user.history || []).slice(-20);
        const historyText = recent.length > 0
            ? `\nRecent chat history between Gumy and ${discordUsername} (their own messages only, last ${recent.length}, for personal context/continuity - reference only if actually relevant):\n${recent.map(h => `${h.role}: ${String(h.content || '').slice(0, 200)}`).join('\n')}`
            : '';
        return `${profileText}${historyText}`;
    } catch (err) {
        console.error('[analyze] Failed to load user context:', err.message);
        return '';
    }
}

function buildAnalysisPrompt(character, playerInfo, researchText, setBonusText, userContext, akashaSummary) {
    return `${GUMY_PERSONA}

You're now acting as an experienced Genshin Impact theorycrafter, in the voice above - talking directly to a streamer who's going to read your reply out loud to their viewers, so keep it Gumy: dry, casual, a little sarcastic, never corporate-assistant-sounding.

Write a natural, conversational reply - like you're actually talking, not filling out a stat sheet. No JSON, no markdown headers, no bullet-point-only answers. Short paragraphs are fine. It's okay to have opinions, but be honest about uncertainty: if something depends on playstyle, rotation, or team comp you don't know, say so directly ("depends on your rotation, but...") instead of stating it as flat fact. The person reading this may push back or ask follow-ups, so don't oversell confidence you don't have.

Tone: this is artifact RNG, not a report card - commentate it the way a streamer reacts to a build reveal, not like you're grading an exam. Bad rolls are bad luck, not a mistake the player made - "RNG really said no" energy, not "this is wrong." Good rolls get genuine hype. Don't be a pushover about actually weak pieces (a badly-rolled 4pc offset by nothing is still worth calling out), but land it with humor/sympathy rather than clinical criticism, and always give the overall vibe some room to be positive even on a rough build - there's usually SOMETHING going right. Keep the rating itself generous relative to how brutal you're being in the text: a build with real problems can still land a 6-7/10 if the bones are right, since most players will never get perfect rolls and that shouldn't read as failing.

Cover, in your own words and order:
- your overall read on the build and what it's good for
- the standout artifact piece(s) - the ones worth reacting to, whether that's a lucky roll worth hyping or an unlucky one worth a laugh - and why (be specific: exact rolls/substats)
- whether ER is sufficient for the kit
- the Crit ratio situation. IMPORTANT: the raw artifact-only Crit Rate/DMG numbers below do NOT include any conditional Crit Rate/DMG granted by the equipped set's bonus (see set bonus text below). Before calling the ratio "skewed," check whether the set bonus adds Crit stats under some condition, and if so mention BOTH the raw number and the effective number once that condition is active - don't just flag it as bad using the raw number alone.
- whether the equipped set(s) actually make sense for this character given what they actually do (see set bonus text below) - call it out if a set bonus is being wasted or underused
- the single upgrade that would matter most, and a rough farming effort estimate

Today's date is ${todayDateString()}.
${researchText ? `Live web research on current meta (gathered specifically just now) - treat as supporting evidence to weigh, not settled truth, and weigh it over your own training data (especially for recently released characters, sets, or weapons your training may not cover). If parts of it look outdated, thin, or conflicting, say so rather than stating it with full confidence:\n${researchText}\n` : 'No live web research was available for this character - be conservative about claims regarding very recent game content, and say so if relevant.\n'}
${setBonusText ? `Confirmed artifact set bonus effects (from Gumy's structured Genshin data and/or live research) - use these exact effects when judging the build, don't assume or misremember set bonuses:\n${setBonusText}\n` : ''}
${akashaSummary ? `Akasha leaderboard standing for this EXACT build (a real damage calculation of it, ranked against every calculated ${character.name} build on akasha.cv - this is not an estimate):\n- Build/rotation: "${akashaSummary.buildName}"${akashaSummary.variantName ? ` (${akashaSummary.variantName} variant)` : ''}, dealing ~${akashaSummary.damage.toLocaleString()} damage per rotation\n- Standing: rank #${akashaSummary.ranking.toLocaleString()} out of ${akashaSummary.outOf.toLocaleString()} = ${akashaSummary.topPercentLabel} of players (${akashaSummary.topPercent}%)\nUse this percentile as your PRIMARY anchor when judging how strong the build is overall - say the bracket ("top 5%") explicitly in your reply. Caveats to keep you honest: Akasha's population skews heavily toward invested players, so even "top 40%" means well above the average player; and it measures raw damage output only - ER comfort, ease of use, and team flexibility aren't captured by it. If the percentile seems inconsistent with what the artifact rolls look like, trust both observations and reason about the gap (weapon, talents, levels, team assumptions in the rotation) instead of ignoring either.` : 'No Akasha ranking exists for this build (the UID was never processed on akasha.cv, or this character has no damage formula there yet). Rate from the stats alone - do NOT invent or imply a percentile.\n'}
Precomputed reference numbers (calculated exactly in code, not by you - use these exact values instead of re-deriving them yourself, especially for the crit ratio):
${character.derived ? JSON.stringify(character.derived, null, 2) : 'unavailable'}
Note: rawCritRatio above is the ARTIFACT-ONLY ratio and does NOT include any conditional set-bonus crit - factor that in separately per the instruction above.

Player: ${playerInfo.nickname} (AR ${playerInfo.level})${playerInfo.signature ? `\nTheir in-game signature/bio: "${playerInfo.signature}"` : ''}
${playerInfo.signature ? `If that signature is actually funny, self-aware, or says something ripe for commentary (self-deprecating joke, a flex, a confession, whatever), feel free to riff on it briefly - rip on them or hype them up depending on what it invites, in the dry Gumy voice. Don't force it if there's nothing there worth touching, and keep it to a line or two, not the focus of the whole reply - the build analysis is still the main event.` : ''}
${userContext || ''}

Character data (structured, exact values):
${safeStringify(character)}

Keep the whole reply under about 1200 characters unless the build genuinely needs more explaining. Plain text only, no code fences.`;
}

// Splash art now comes from the local thumbnail cache (image-cache.js) -
// disk hit = zero network; miss = one fetch + resize, cached thereafter.
// Keyed by avatarId so it stays valid across CDN mirror changes.
async function analyzeCharacter(character, imageUrl, playerInfo, openai, researchText, setBonusText, userContext, akashaSummary, log) {
    const content = [{ type: 'text', text: buildAnalysisPrompt(character, playerInfo, researchText, setBonusText, userContext, akashaSummary) }];
    if (imageUrl && character.avatarId) {
        // image-cache derives the full mirror chain from the URL's file name
        // (enka's default top-priority host, homdgcat.wiki, has been down).
        const dataUrl = await getCachedImageDataUrl({
            key: String(character.avatarId),
            url: imageUrl,
            log,
        });
        if (dataUrl) {
            content.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
            log(`Proceeding without vision input for ${character.name} - no usable image.`);
        }
    }

    const messages = [
        { role: 'system', content: 'You are Gumy. Follow the persona and instructions given in the user message exactly. Reply in plain conversational text only - no JSON, no markdown headers, no code fences.' },
        { role: 'user', content },
    ];
    log(`Calling model for ${character.name}'s analysis...`);
    const response = await openai.chat.completions.create({
        model: 'gpt-5.6-luna',
        messages,
        // The default (medium) reasoning level was consuming the entire old
        // 700-token completion budget, yielding an empty visible response.
        // A short build review benefits from low reasoning plus enough room
        // for the actual Discord-facing answer.
        reasoning_effort: 'low',
        max_completion_tokens: 1600,
    });

    let text = response.choices?.[0]?.message?.content?.trim();
    if (!text) {
        const finishReason = response.choices?.[0]?.finish_reason ?? 'unknown';
        const tokens = response.usage?.completion_tokens ?? '?';
        console.error(`[analyze] Empty analysis for ${character.name} (finish: ${finishReason}, completion tokens: ${tokens}); retrying without reasoning.`);
        log(`Initial analysis was empty (finish: ${finishReason}, ${tokens} completion tokens); retrying without reasoning.`);

        // A rare safety net: the command should never discard all successful
        // Enka and research work merely because a reasoning pass spent its
        // visible-output budget. The retry keeps the same evidence and image.
        const fallback = await openai.chat.completions.create({
            model: 'gpt-5.6-luna',
            messages,
            reasoning_effort: 'none',
            max_completion_tokens: 1600,
        });
        text = fallback.choices?.[0]?.message?.content?.trim();
        if (!text) {
            const fallbackFinish = fallback.choices?.[0]?.finish_reason ?? 'unknown';
            console.error(`[analyze] Fallback analysis was also empty for ${character.name} (finish: ${fallbackFinish}).`);
            log(`Fallback analysis was also empty (finish: ${fallbackFinish}).`);
            return null;
        }
        log(`Fallback analysis complete for ${character.name} (${text.length} chars).`);
        return text;
    }
    log(`Analysis complete for ${character.name} (${text.length} chars).`);
    return text;
}

function splitMessage(text, max = 1900) {
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
    return chunks;
}

// Splash art goes out as a real Discord attachment of the local cached
// thumbnail, not the Enka image URL: the library builds that URL against
// homdgcat.wiki (its top-priority mirror, unreliable here), and attaching
// the cached file works whether or not any CDN is reachable. Character
// names can contain spaces/apostrophes - sanitize for a Discord filename.
function buildImageAttachment(character, buffer) {
    if (!buffer) return null;
    const safeName = (character.name || 'character').replace(/[^\w-]+/g, '_');
    return new AttachmentBuilder(buffer, {
        name: `${safeName}.jpg`,
        description: `${character.name} splash art (cached thumbnail)`,
    });
}

// Plain text, not an embed - deliberately. Gumy's reply-chain awareness
// (in index.js) only reads message.content when someone replies to an
// earlier message, so an embed-only analysis is invisible if the streamer
// or a viewer later replies to it with a follow-up doubt/question.
function buildAnalysisText(character, analysisText, sources, setBonusText, setBonusLocalSource, akashaSummary) {
    let text = `**${character.name} — Build Analysis**\n`;
    if (akashaSummary) {
        // Shown as its own visible line (not buried in the AI's prose) so the
        // percentile is always stated even if the model glosses over it.
        text += `**Akasha: ${akashaSummary.topPercentLabel}** — #${akashaSummary.ranking.toLocaleString()} of ${akashaSummary.outOf.toLocaleString()} · ~${akashaSummary.damage.toLocaleString()} dmg/rotation${akashaSummary.variantName ? ` · ${akashaSummary.variantName}` : ''} · <${akashaSummary.leaderboardUrl}>\n`;
    }
    text += `-# Build data via Enka Network API · set/meta info verified live · if a stat here looks off, open that character's detail page in-game once (that's what actually syncs it), then hit refresh on enka.network or akasha.cv for your UID.\n\n`;
    text += analysisText || 'Gumy had trouble putting this analysis together. Try again in a moment.';

    if (setBonusText) {
        text += `\n\n**Equipped Set Bonuses (${setBonusLocalSource || 'live research'}):**\n${setBonusText}`;
    }

    if (sources && sources.length > 0) {
        text += `\n\n**Sources (live meta check):**\n${sources.slice(0, 4).map(s => `${(s.title || s.url).slice(0, 60)} - <${s.url}>`).join('\n')}`;
    } else {
        text += `\n\n*No live meta sources found — take this analysis with a grain of salt.*`;
    }

    // Splash art is attached as a file by the caller (buildImageAttachment) -
    // no image URL goes into the text itself.

    return text;
}

function buildCharacterSelectMenu(characters) {
    const options = characters.slice(0, 24).map((c, i) => ({
        label: c.name,
        description: `Lv${c.level} C${c.constellation} · ${c.weapon?.name ?? 'No weapon'}`.slice(0, 100),
        value: String(i),
    }));

    const menu = new StringSelectMenuBuilder()
        .setCustomId('analyze_char_select')
        .setPlaceholder('Choose a character to analyze')
        .addOptions(options);

    return new ActionRowBuilder().addComponents(menu);
}

// Gets its own logger scoped to this one character's research (see
// createLogger above) - kept as a separate function since it's called from
// both the single-showcased-character path and the selector path below.
// akashaCalcs is the already-fetched per-UID Akasha calculation list (see
// handleAnalyzeCommand) - matching THIS character out of it is synchronous,
// so it adds zero extra requests per character analyzed.
async function runAnalysis(character, playerInfo, openai, userContext, akashaCalcs) {
    const log = createLogger();
    log(`Starting analysis for ${character.name}...`);
    const visualUrl = character.imageUrl;

    // Match by Enka's numeric avatarId. null here is normal, not an error:
    // either this UID was never processed on akasha.cv, or that character
    // has no damage formula there (common for very new characters).
    const akashaSummary = Array.isArray(akashaCalcs) && akashaCalcs.length > 0
        ? summarizeAkashaCharacter(akashaCalcs, character.avatarId)
        : null;
    if (akashaSummary) {
        log(`Akasha: ${akashaSummary.topPercentLabel} (#${akashaSummary.ranking}/${akashaSummary.outOf}).`);
    } else {
        log('No Akasha ranking for this character - proceeding without percentile.');
    }

    try {
        const setNames = (character.artifacts || []).map(a => a.setName);
        const [research, setBonus, imageBuffer] = await Promise.all([
            getBuildResearchContext(character.name, openai, log),
            getSetBonusResearch(setNames, openai, log),
            // Same cached thumbnail feeds both the vision input (analyzeCharacter)
            // and the Discord attachment - one lookup, two uses.
            character.avatarId
                ? getCachedImageBuffer({ key: String(character.avatarId), url: visualUrl, log })
                : Promise.resolve(null),
        ]);
        const attachment = buildImageAttachment(character, imageBuffer);
        if (attachment) {
            log(`Attaching cached splash art for ${character.name}.`);
        } else {
            log(`No cached splash art to attach for ${character.name}.`);
        }

        const analysis = await analyzeCharacter(character, visualUrl, playerInfo, openai, research.text, setBonus.text, userContext, akashaSummary, log);

        const seenUrls = new Set();
        const mergedSources = [...research.sources, ...setBonus.sources].filter(s => (seenUrls.has(s.url) ? false : (seenUrls.add(s.url), true)));

        const text = buildAnalysisText(character, analysis, mergedSources, setBonus.text, setBonus.localSource, akashaSummary) + log.block();
        return { text, attachment };
    } catch (err) {
        console.error(`[analyze] Analysis failed for ${character.name}:`, err.message);
        log(`Analysis failed: ${err.message}`);
        return { text: `**${character.name} — Build Analysis**\n\nGumy hit an error analyzing this character. Try again in a moment.${log.block()}`, attachment: null };
    }
}

// Sends text as one editReply/followUp per ~1900-char chunk, since Discord
// caps message content at 2000 chars regardless of embed vs plain text.
// `files` (if any) rides on the first chunk so the splash art lands with the
// analysis header even when the reply gets split.
async function sendChunked(interaction, text, { isFirst, files } = {}) {
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i++) {
        if (isFirst && i === 0) {
            await interaction.editReply({
                content: chunks[i],
                embeds: [],
                components: [],
                ...(files && files.length > 0 ? { files } : {}),
            });
        } else {
            await interaction.followUp({ content: chunks[i] });
        }
    }
}

async function handleAnalyzeCommand(interaction, { db, openai, getUser, saveHistoryMessages }) {
    const log = createLogger();
    log(`/analyze invoked by ${interaction.user.tag}`);
    await interaction.deferReply();

    const userContext = buildUserContextBlock(getUser, interaction.user.id, interaction.user.username);

    function rememberAnalysis(character, text) {
        if (!saveHistoryMessages) return;
        saveHistoryMessages(interaction.user.id, interaction.user.username, [
            { role: 'user', content: `/analyze requested for ${character.name}` },
            { role: 'assistant', content: text },
        ]);
        log(`Saved ${character.name} analysis to conversation history.`);
    }

    const uid = await resolveUid(interaction, db);
    if (!uid) {
        log('No UID could be resolved.');
        return interaction.editReply(`I couldn't find a UID for that. Either pass \`uid:\` directly, or have them run \`/link\` first.${log.block()}`);
    }
    log(`Resolved UID: ${uid}`);

    let profile;
    try {
        log(`Fetching Enka profile for UID ${uid}...`);
        profile = await fetchEnkaProfile(uid);
        log(`Enka fetch OK - player ${profile.playerInfo.nickname}, ${profile.characters.length} showcased character(s): ${profile.characters.map(c => c.name).join(', ')}`);
    } catch (err) {
        console.error('[analyze] Enka fetch failed:', err.message);
        console.error(err.stack); // full trace, server console only - need this to actually diagnose library-internal failures
        log(`Enka fetch failed: ${err.message}`);

        let explanation;
        if (/fetchAllContents|cachedAssetsManager|CachedAssetsManager/i.test(err.message)) {
            // This is a stale local game-data cache on our end (a character
            // has a costume/profile picture newer than what's cached) - has
            // nothing to do with the UID or showcase settings, and saying
            // otherwise would be actively misleading.
            explanation = `that's a stale local game-data cache on my end (something in that showcase is newer than my cached game data) - not your UID or Character Showcase settings, genuine backend issue. Should self-correct on its own; try again in a minute, or flag it to lefye if it keeps happening on this UID specifically.`;
        } else if (/Unexpected value.*detected/i.test(err.message)) {
            // This is the enka-network-api library's own internal type-check
            // assertion failing while parsing something in this account's
            // showcase - not a cache issue, not the UID being wrong. Likely
            // one specific character/item the library doesn't handle
            // cleanly yet. Honest about not knowing exactly which one
            // without a deeper look, rather than pretending certainty.
            explanation = `hit an internal bug in the Enka library itself while reading that account's showcase - something in there (probably one specific character or item) trips up its parsing. Not your UID, not a cache issue this time, genuine library-level bug. As a workaround, try changing the in-game Character Showcase to a different set of characters and see if it goes through - and this is worth flagging to lefye either way since it points at a real fix needed on the backend.`;
        } else if (/404|not found/i.test(err.message)) {
            explanation = `Enka Network doesn't have any data for that UID at all - either it's mistyped, or the in-game Character Showcase has never actually been opened (open your in-game profile once so it syncs to Enka).`;
        } else if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(err.message)) {
            explanation = `Enka Network's own API timed out on this request - their servers being slow, not a problem with your UID. Try again shortly.`;
        } else {
            explanation = `hit a real backend error talking to Enka Network (${err.message}) - not a "couldn't find your build" thing, an actual failure. Try again in a moment.`;
        }

        return interaction.editReply(`Couldn't fetch UID \`${uid}\`: ${explanation}${log.block()}`);
    }

    if (!profile.characters || profile.characters.length === 0) {
        return interaction.editReply(`No showcased characters found for UID \`${uid}\`. Set a Character Showcase in-game first.${log.block()}`);
    }

    // One Akasha fetch covers every showcased character on this UID. An
    // empty list is normal (never submitted to akasha.cv, or their API
    // hiccuped) - analysis just proceeds without a percentile. Fire-and-
    // forget refresh in that case so the NEXT /analyze of this UID has
    // ranking data ready; never awaited, adds no latency.
    const akashaCalcs = await getAkashaCalculationsForUser(uid);
    if (akashaCalcs.length > 0) {
        log(`Akasha data available for this UID (${akashaCalcs.length} ranked character(s)).`);
    } else {
        log('No Akasha data for this UID yet - requesting a background refresh for next time.');
        void refreshAkashaUser(uid);
    }

    // Single showcased character - no need to make them pick. Command-level
    // trace (UID resolution, Enka fetch) gets merged with this character's
    // own research trace, since this is the only message that goes out.
    if (profile.characters.length === 1) {
        const { text, attachment } = await runAnalysis(profile.characters[0], profile.playerInfo, openai, userContext, akashaCalcs);
        log('Sending single-character reply.');
        const reply = `<@${interaction.user.id}> **${profile.playerInfo.nickname}** (AR ${profile.playerInfo.level}):\n\n${text}${log.block()}`;
        await sendChunked(interaction, reply, { isFirst: true, files: attachment ? [attachment] : [] });
        rememberAnalysis(profile.characters[0], reply);
        return;
    }

    const row = buildCharacterSelectMenu(profile.characters);
    const selectMsg = await interaction.editReply({
        content: `<@${interaction.user.id}> **${profile.playerInfo.nickname}** (AR ${profile.playerInfo.level}) — which character do you want analyzed?${log.block()}`,
        components: [row],
    });
    log('Character select menu shown, awaiting user choice (60s timeout)...');

    let choice;
    try {
        choice = await selectMsg.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            filter: i => i.user.id === interaction.user.id,
            time: 60_000,
        });
    } catch {
        log('Selection timed out.');
        return interaction.editReply({ content: `Selection timed out — run \`/analyze\` again when you're ready.${log.block()}`, components: [] });
    }

    await choice.deferUpdate();
    log(`User chose: ${choice.values[0]}`);

    const character = profile.characters[Number(choice.values[0])];
    const { text, attachment } = await runAnalysis(character, profile.playerInfo, openai, userContext, akashaCalcs);
    const reply = `<@${interaction.user.id}> **${profile.playerInfo.nickname}** (AR ${profile.playerInfo.level}):\n\n${text}`;
    await sendChunked(interaction, reply, { isFirst: true, files: attachment ? [attachment] : [] });
    rememberAnalysis(character, reply);
    log(`Sent result for ${character.name}. Done.`);
}

module.exports = { setupLinkTable, handleLinkCommand, handleAnalyzeCommand, getLinkedUid, buildAnalysisPrompt, buildAnalysisText };