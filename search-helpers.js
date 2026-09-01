// Shared across index.js (general web search + genshin_build research) and
// analyze-command.js (/analyze meta + set-bonus research). Responses API web
// search citations live in output-text annotations, while the actual search
// calls can also expose their source URLs. Read both, then dedupe them.
function extractSources(response) {
    const seen = new Set();
    const sources = [];
    const add = (url, title) => {
        if (url && !seen.has(url)) {
            seen.add(url);
            sources.push({ title: title || url, url });
        }
    };

    // Kept for compatibility with any legacy Chat Completions callers.
    for (const annotation of response?.annotations || []) {
        if (annotation.type === 'url_citation') {
            add(annotation.url || annotation.url_citation?.url, annotation.title || annotation.url_citation?.title);
        }
    }

    // Citations are the sources the model actually relied on in its written
    // answer, so they must appear before the broader list of pages consulted.
    for (const item of response?.output || []) {
        if (item.type === 'message') {
            for (const part of item.content || []) {
                for (const annotation of part.annotations || []) {
                    if (annotation.type === 'url_citation') add(annotation.url, annotation.title);
                }
            }
        }
    }
    for (const item of response?.output || []) {
        if (item.type === 'web_search_call') {
            for (const source of item.action?.sources || []) add(source.url, source.title);
        }
    }

    return sources
}

function formatSources(sources, max = 4) {
    const visible = (sources || []).slice(0, max);
    if (visible.length === 0) return '';
    return `\n\n**Sources used:**\n${visible.map(source => {
        const title = String(source.title || source.url).replace(/[\r\n]+/g, ' ').slice(0, 90);
        return `- ${title} — <${source.url}>`;
    }).join('\n')}`;
}

// Known-good Genshin sources to explicitly bias toward, since a generic
// keyword search can surface completely unrelated pages (marketing PDFs,
// press releases from unrelated businesses, etc.) that merely mention the
// game's name. This doesn't restrict the search - it just tells the model
// what "authoritative" actually looks like for this topic.
const GENSHIN_TRUSTED_SOURCES = 'hoyolab.com, genshin.hoyoverse.com (official), game8.co/genres/genshin-impact, prydwen.gg, keqingmains.com, genshin-impact.fandom.com, icy-veins.com, gematsu.com, gamemarket.gg';

// Reddit is a genuinely valuable source for BREAKING/rumor-tier Genshin
// content specifically (leaks, datamines, beta findings) - official/wiki
// sources are often days behind on this. But it's fundamentally
// speculation-tier, not fact-tier, so it needs its own explicit confidence
// framing rather than being treated the same as an official source.
const GENSHIN_LEAK_SOURCES = 'r/Genshin_Impact_Leaks, r/Genshin_Impact, other well-established Genshin leak communities';

// A human-maintained ground-truth fact, stronger than "today's date" alone
// for judging currency - e.g. a search result can have a recent date but
// still describe an OLD patch if published mid-patch. Update this string
// (and CURRENT_PATCH_UPDATED) whenever a new patch drops. Set to null to
// disable this grounding fact and fall back to date-only reasoning.
// Do not hard-code a patch number here: it silently turns into a false
// "ground truth" after each game update and causes fresh evidence to be
// discarded. Currentness is established from the retrieved sources instead.
const GENSHIN_CURRENT_PATCH = null;

// The search model's job is to gather evidence, not to author the final
// answer - it should be skeptical of its own results, not just summarize
// whatever comes back. This is the shared "researcher" framing used by
// every search call site, with the real current date injected (the model
// otherwise has no reliable way to know "today", which breaks any judgment
// about whether a source is current or stale).
function buildResearcherSystemPrompt(taskInstructions, { genshinTopic = false, allowLeakSources = false } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();
    return `Today's date is ${today}. You are a RESEARCHER gathering evidence for someone else to reason over - not the final answer-giver. Be skeptical, not just a summarizer.

${taskInstructions}

HARD RULE for anything time-sensitive ("today", "latest", "current", "right now", current patch/meta/version, current events, prices, etc.):
A source only counts as evidence of the CURRENT state of things if it demonstrably reflects ${currentYear} - e.g. it states a ${currentYear} date, a version/patch you know to be current, or otherwise unambiguously describes the present, not just that it was the most relevant search hit. If every result you found fails that bar (old articles, undated pages, marketing/PR pages, pages about an unrelated topic that merely mention the keyword), DO NOT cite or summarize them as if they answer the question - explicitly say you couldn't find anything confirmed current. A confident "I don't know" beats confidently repeating a stale or irrelevant page.
${genshinTopic && GENSHIN_CURRENT_PATCH ? `\nGROUND TRUTH: the current Genshin Impact patch is ${GENSHIN_CURRENT_PATCH}. Treat this as more reliable than a source's publish date alone - a recently-dated page can still describe an OLDER patch if it was written mid-cycle. If a source's content doesn't match patch ${GENSHIN_CURRENT_PATCH}, flag it as outdated even if the date looks recent.\n` : ''}
${genshinTopic ? `\nFor Genshin Impact topics specifically, prioritize known-good sources: ${GENSHIN_TRUSTED_SOURCES}, or official HoYoverse channels/announcements. Treat anything outside gaming-news/community-wiki/official-source territory (marketing pages, unrelated businesses, tourism/attraction sites, etc.) as NOT a valid source for this, even if it happens to contain the word "Genshin" - that's a keyword collision, not a relevant result.\n` : ''}
${genshinTopic && allowLeakSources ? `\nFor leaks/rumors/unreleased content specifically, ${GENSHIN_LEAK_SOURCES} are ALSO valid sources - official channels won't cover this by definition. But this is speculation-tier, not fact-tier: explicitly label confidence per claim (e.g. "High confidence" for corroborated datamine findings, "Low confidence" for single-source speculation), and keep leak-tier and confirmed-official information visibly separate rather than blending them into one undifferentiated summary.\n` : ''}
Other rules, same spirit:
- If a source is discussing an older patch, version, or period, say so explicitly rather than presenting it as the current state of things.
- If sources conflict, say so rather than silently picking one.
- Never fill gaps with a guess - if you can't confirm something, say that plainly.
- Prefer authoritative/primary/official sources; for community topics (e.g. game builds/guides), prefer current, reputable sources over old ones. A marketing/PR page or an unrelated business's press release is not a valid source for game content questions even if it happens to mention the game's name.
- For anything NOT time-sensitive (how a mechanic fundamentally works, historical facts, etc.), the year-gate above doesn't apply - use judgment.`;
}

function todayDateString() {
    return new Date().toISOString().slice(0, 10);
}

function isGenshinRelated(text) {
    return /\b(genshin|hoyoverse|hoyolab|teyvat|mihoyo)\b/i.test(text || '');
}

function isBannerQuestion(text) {
    return /\b(banner|wish(es)?|gacha|pull(s|ing)?|rate.?up)\b/i.test(text || '');
}

function isLeakQuestion(text) {
    return /\b(leak(s|ed)?|rumou?r(s)?|datamine[ds]?|beta|upcoming|unreleased|next patch)\b/i.test(text || '');
}

// Casual Discord messages ("heya gumy whats the new banners xd genshin") make
// bad search-engine queries - greetings, slang, emotes, and bot mentions all
// dilute what's actually being asked. This strips it down to a clean query
// before it ever reaches the search model, for both the classifier-triggered
// chat path and /search. Fails open (returns the raw message) if the model
// call errors, rather than blocking the search entirely over this.
async function refineSearchQuery(rawMessage, openai) {
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-5.4-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Rewrite the user\'s casual message into a clean, effective search-engine query capturing exactly what they want to know. Strip greetings, filler, slang, emotes, and any bot name/mention. Keep it short - a few words, like what someone would actually type into a search bar. Output ONLY the query text, nothing else - no quotes, no explanation, no punctuation at the end.'
                },
                { role: 'user', content: rawMessage }
            ],
            max_completion_tokens: 40
        });
        const refined = res.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
        return refined || rawMessage;
    } catch (err) {
        console.error('[search] Query refinement failed, using raw message:', err.message);
        return rawMessage;
    }
}

// Same idea as refineSearchQuery, but detects when a message actually
// contains TWO distinct questions/asks (e.g. "check the banners AND any
// rumors for 7.1") and splits them into separate clean queries instead of
// merging them into one - a single merged query was silently dropping
// whichever question lost out in the merge. Returns an array of 1-2 queries.
async function refineSearchQueries(rawMessage, openai) {
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-5.4-mini',
            messages: [
                {
                    role: 'system',
                    content: 'The user\'s message may contain ONE or TWO genuinely distinct questions/requests. If there are two, break them into two separate clean search-engine queries - one per question, don\'t merge them into one. If there\'s really only one question, output just that one. Strip greetings, filler, slang, emotes, and any bot name/mention from each. Output ONLY the query text(s), one per line, nothing else - no numbering, no quotes, no explanation.'
                },
                { role: 'user', content: rawMessage }
            ],
            max_completion_tokens: 60
        });
        const raw = res.choices?.[0]?.message?.content?.trim() || '';
        const queries = raw.split('\n')
            .map(q => q.trim().replace(/^["'\-\d.)]+\s*/, '').replace(/^["']|["']$/g, ''))
            .filter(Boolean)
            .slice(0, 2);
        return queries.length > 0 ? queries : [rawMessage];
    } catch (err) {
        console.error('[search] Multi-query refinement failed, using raw message:', err.message);
        return [rawMessage];
    }
}

// Runs 1-2 refined queries in parallel and merges their evidence + sources
// into one combined result, so the final answer has what it needs to
// address every distinct question that was actually asked.
async function runMultiSearch(queries, openai, { genshinTopic = false, allowLeakSources = false } = {}) {
    const results = await Promise.all(queries.map(q => getWebSearchResult(q, openai, { genshinTopic, allowLeakSources })));
    const texts = results.map((r, i) => r.text ? `[Re: "${queries[i]}"]\n${r.text}` : null).filter(Boolean);
    const seen = new Set();
    const sources = results.flatMap(r => r.sources).filter(s => (seen.has(s.url) ? false : (seen.add(s.url), true)));
    return { text: texts.length > 0 ? texts.join('\n\n') : null, sources, queryCount: queries.length };
}

// Moved here from index.js so both the classifier-triggered chat path and
// the /search slash command share one implementation instead of drifting.
async function getWebSearchResult(query, openai, { genshinTopic = false, allowLeakSources = false } = {}) {
    try {
        const searchResponse = await openai.responses.create({
            model: 'gpt-5.6-luna',
            instructions: buildResearcherSystemPrompt('Search the web and return a concise factual summary relevant to the question. No fluff, just the key info. Cite each factual claim using the web sources you found.', { genshinTopic, allowLeakSources }),
            input: query,
            tools: [{ type: 'web_search', search_context_size: 'high' }],
            include: ['web_search_call.action.sources'],
            reasoning: { effort: 'low' },
            max_output_tokens: 1200,
        });
        const text = searchResponse.output_text?.trim() || null;
        const sources = extractSources(searchResponse);
        return { text, sources };
    } catch (err) {
        console.error('Web search failed:', err.message);
        return { text: null, sources: [] };
    }
}

async function getWebResearch(query, openai, instructions, { genshinTopic = false, allowLeakSources = false, maxOutputTokens = 1000 } = {}) {
    try {
        const response = await openai.responses.create({
            model: 'gpt-5.6-luna',
            instructions: buildResearcherSystemPrompt(instructions, { genshinTopic, allowLeakSources }),
            input: query,
            tools: [{ type: 'web_search', search_context_size: 'high' }],
            include: ['web_search_call.action.sources'],
            reasoning: { effort: 'low' },
            max_output_tokens: maxOutputTokens,
        });
        return { text: response.output_text?.trim() || null, sources: extractSources(response) };
    } catch (err) {
        console.error('Web research failed:', err.message);
        return { text: null, sources: [] };
    }
}

// Hard guarantee, not a prompt suggestion: for Genshin banner questions,
// always append real, stable links to check current banners, regardless of
// whether the search succeeded or the model handled uncertainty gracefully.
// This is the fix for Gumy telling someone to go verify it themselves and
// stopping there instead of giving them something to actually click.
function appendBannerLinksIfNeeded(content, query) {
    if (isGenshinRelated(query) && isBannerQuestion(query) && !content.includes('prydwen.gg/genshin-impact/banners')) {
        return `${content}\n\nCheck current banners here: <https://www.prydwen.gg/genshin-impact/banners> | <https://game8.co/games/Genshin-Impact/archives/305012>`;
    }
    return content;
}

module.exports = {
    extractSources,
    formatSources,
    buildResearcherSystemPrompt,
    todayDateString,
    isGenshinRelated,
    isBannerQuestion,
    isLeakQuestion,
    refineSearchQuery,
    refineSearchQueries,
    runMultiSearch,
    getWebSearchResult,
    getWebResearch,
    appendBannerLinksIfNeeded,
    GENSHIN_CURRENT_PATCH,
};