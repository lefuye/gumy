// ─── Akasha System integration ─────────────────────────────────────────────
//
// akasha.cv is a community Genshin Impact damage-leaderboard site: it takes
// a player's Enka showcase, runs each character's build through a real
// damage calculation, and ranks it against every other calculated build for
// that same character/rotation. This wraps that ranking data so /analyze
// can say things like "top 3%" instead of just showing raw stats in a
// vacuum.
//
// There is NO official public API or documentation for this. The endpoint
// below was reverse-engineered by the open-source akasha-py project
// (https://github.com/seriaati/akasha-py) - its own README explicitly warns
// the site's maintainer changes the API "very frequently, and without
// notice." Treat every call here as best-effort: fail soft, never let an
// Akasha hiccup break /analyze.
//
// IMPORTANT: a UID only has data here once it's actually been processed by
// Akasha - someone has to enter it at https://akasha.cv at least once (or
// it gets refreshed via the API). A never-submitted UID returns an EMPTY
// list, not an error - that's an expected, normal outcome, not a bug to
// alarm about.
//
// Also: not every character has a ranking even on a processed UID - Akasha
// needs an actual damage-calc formula defined for that character first, so
// very recently released characters especially may just be absent from the
// results despite being shown in Character Showcase.

const https = require('https');

const BASE_URL = 'https://akasha.cv/api';
// This exact User-Agent matters: akasha.cv sits behind a Cloudflare rule
// that serves a JS challenge ("Just a moment...", HTTP 403) to generic/bot
// UAs, but allowlists the UA used by the akasha-py project this endpoint
// was reverse-engineered from. Verified live 2026-08-22: 'Gumy-Discord-Bot'
// -> 403 challenge page, 'akasha-py' -> 200 JSON. Don't change this back to
// a custom UA without re-testing.
const USER_AGENT = 'akasha-py';

// Uses node's low-level https module, NOT global fetch - deliberately.
// Verified live 2026-08-22: identical headers get 200 via https.request but
// a Cloudflare challenge (403 + cf-mitigated: challenge) via undici/fetch -
// Cloudflare fingerprints the client's TLS/HTTP stack, not just headers, and
// undici's fingerprint trips it where node's classic https client doesn't.
function akashaFetch(path, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(`${BASE_URL}/${path}`, {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        }, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume(); // drain so the socket can be reused/destroyed cleanly
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    // Akasha wraps most successful payloads as { data: [...] },
                    // but not consistently across every endpoint - normalize both.
                    resolve(json?.data ?? json);
                } catch (err) {
                    reject(new Error(`Unparseable response from Akasha: ${err.message}`));
                }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
        req.on('error', reject);
        req.end();
    });
}

// Raw list of per-character calculation entries for a UID. Returns [] both
// when the UID has never been processed by Akasha AND on any request
// failure - callers can't (and don't need to) tell those apart, since
// either way the right move is "just don't show Akasha data this time."
async function getAkashaCalculationsForUser(uid) {
    try {
        const data = await akashaFetch(`getCalculationsForUser/${uid}`);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error(`[akasha] getCalculationsForUser failed for UID ${uid}:`, err.message);
        return [];
    }
}

// The calculations field has changed shape across API revisions: it used to
// be an ARRAY of variant objects, and is now an OBJECT keyed by variant
// (e.g. { fit: {...} }) - or null while Akasha is still processing the build.
// Verified live 2026-08-22. Normalize both to a plain array of variants.
function normalizeVariants(entry) {
    const calcs = entry.calculations;
    if (!calcs) return [];
    const list = Array.isArray(calcs) ? calcs : Object.values(calcs);
    return list.filter(Boolean);
}

// Akasha's conventional percentile brackets (top 1%, then 5% steps up to
// 50%) - computed here in code, not left to the AI, since that's exactly the
// kind of rounding math LLMs get subtly wrong.
function topPercentLabel(pct) {
    if (pct <= 1) return 'Top 1%';
    for (let s = 5; s <= 50; s += 5) {
        if (pct <= s) return `Top ${s}%`;
    }
    return pct <= 100 ? `Top ${Math.min(99, Math.ceil(pct))}%` : 'Unranked';
}

// Picks out one character's ranking from the full per-UID list, matched by
// Enka's avatarId - Akasha's own characterId uses the identical underlying
// Genshin avatar-ID scheme, so this is a direct numeric match, no
// name-guessing needed.
//
// A character can have multiple ranked "variants" (different rotations or
// playstyles - e.g. a Melt build vs a Vaporize build for the same
// character, or ER brackets like "120% ER"). The primary one is whichever
// variant has the lowest `priority` number (Akasha's own ordering field);
// fall back to first-listed when it's absent. Remaining variants are just
// counted, not shown.
function summarizeAkashaCharacter(userCalcs, avatarId) {
    const entry = userCalcs.find(c => Number(c.characterId) === Number(avatarId));
    if (!entry) return null;

    const variants = normalizeVariants(entry);
    const ranked = variants.filter(v => v.ranking != null && v.outOf);
    if (ranked.length === 0) return null;

    ranked.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
    const primary = ranked[0];

    const topPercent = (primary.ranking / primary.outOf) * 100;

    return {
        buildName: primary.short || primary.name || primary.details || 'Calculated build',
        variantName: primary.variant?.displayName || primary.variant?.name || null,
        damage: Math.round(primary.result),
        ranking: primary.ranking,
        outOf: primary.outOf,
        topPercent: +topPercent.toFixed(2),
        topPercentLabel: topPercentLabel(topPercent),
        otherVariantCount: ranked.length - 1,
        leaderboardUrl: `https://akasha.cv/leaderboards/${primary.calculationId}`,
    };
}

// Convenience wrapper: fetch + match in one call. Returns null on any
// failure OR if this specific character just isn't ranked - /analyze should
// treat both the same way (omit the section, don't treat it as an error).
async function getAkashaSummaryForCharacter(uid, avatarId) {
    if (!avatarId) return null;
    const userCalcs = await getAkashaCalculationsForUser(uid);
    if (userCalcs.length === 0) return null;
    return summarizeAkashaCharacter(userCalcs, avatarId);
}

// Asks Akasha to pull/refresh a UID's Enka showcase and (re)calculate its
// builds. Server-side and asynchronous - the result won't be visible in this
// request, but it means a UID's FIRST /analyze primes it for every later
// one. Intended as fire-and-forget: callers deliberately don't await this,
// so it never adds latency to a reply.
async function refreshAkashaUser(uid) {
    try {
        await akashaFetch(`user/refresh/${uid}`);
        console.log(`[akasha] Refresh requested for UID ${uid}.`);
    } catch (err) {
        console.error(`[akasha] refresh failed for UID ${uid}:`, err.message);
    }
}

module.exports = { getAkashaCalculationsForUser, summarizeAkashaCharacter, getAkashaSummaryForCharacter, refreshAkashaUser };
