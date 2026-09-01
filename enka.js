// ─── Enka Network integration ──────────────────────────────────────────────
//
// Wraps the `enka-network-api` package (https://github.com/yuko1101/enka-network-api)
// to fetch a player's showcased Genshin characters and turn them into:
//   1) a compact JSON summary (exact numbers, for the AI to reason about)
//   2) a build card image URL (for the AI's vision input)
//
// NOTE: enka-network-api's exact property names have shifted across major
// versions before (see its CHANGELOG). If fields below come back undefined,
// run `node debug-enka.js <uid>` (included alongside this file) to dump the
// raw character object and patch the accessors here.

const { EnkaClient } = require('enka-network-api');

const enka = new EnkaClient({
    userAgent: 'Gumy-Discord-Bot/1.0',
    defaultLanguage: 'en',
    // Docs recommend keeping the cache in the project folder (not
    // node_modules) specifically when using the auto cache updater below,
    // so it survives npm reinstalls instead of getting wiped.
    cacheDirectory: './enka-cache',
});

// Genshin regularly adds new characters, costumes, and profile pictures.
// enka-network-api caches a local snapshot of that game data, and without
// refreshing it, fetchUser() throws "X was not found" for ANY player
// showcasing something newer than the cache snapshot - this is exactly what
// caused "my UID works, but others don't": whoever set this cache up just
// happened to have only older content in their own showcase.
//
// IMPORTANT: activateAutoCacheUpdater's instant:true already performs the
// equivalent of fetchAllContents() internally on startup. Calling
// fetchAllContents() separately AS WELL causes a hard crash ("You are
// already fetching assets") since they race for the same fetch lock - these
// are meant to be alternative patterns per the docs, not combined. So the
// "cache ready" signal below is derived purely from onUpdateEnd firing,
// not a second competing fetch call.
let resolveCacheReady;
const cacheReadyPromise = new Promise(resolve => { resolveCacheReady = resolve; });
let firstUpdateSeen = false;

enka.cachedAssetsManager.activateAutoCacheUpdater({
    instant: true, // check immediately on startup, not just after the first interval
    timeout: 60 * 60 * 1000, // then recheck every hour
    onUpdateStart: async () => console.log('[enka] Checking for game data updates...'),
    onUpdateEnd: async () => {
        enka.cachedAssetsManager.refreshAllData();
        console.log('[enka] Game data cache refreshed.');
        if (!firstUpdateSeen) {
            firstUpdateSeen = true;
            resolveCacheReady();
        }
    },
});

// Safety net: if onUpdateEnd never fires for some reason (unexpected error
// inside the library, no update needed so it skips the callback, etc.),
// don't let fetchEnkaProfile() hang forever waiting on it - fall back to
// whatever's already on disk after a reasonable wait.
setTimeout(() => {
    if (!firstUpdateSeen) {
        console.error('[enka] Cache update check never completed after 30s - proceeding with existing cache on disk.');
        firstUpdateSeen = true;
        resolveCacheReady();
    }
}, 30_000);

// Enka showcases only expose a UID's *currently displayed* characters —
// there's no way to pull a full roster, which matches how the in-game
// Character Showcase works.
// enka-network-api reuses the same StatProperty shape for character stats,
// artifact main/substats, and weapon stats: { fightProp, fightPropName
// (TextAssets), value, isPercent }. One formatter covers all three.
function formatStat(sp) {
    if (!sp) return null;
    const name = sp.fightPropName?.get?.('en') ?? sp.fightProp ?? 'Unknown Stat';
    const raw = sp.value;
    if (raw == null) return null;
    const value = sp.isPercent ? `${(raw * 100).toFixed(1)}%` : Number(raw).toFixed(1);
    return { name, value };
}

async function fetchEnkaProfile(uid) {
    await cacheReadyPromise; // no-op after the first call, since the promise is already settled
    const user = await enka.fetchUser(uid);

    const playerInfo = {
        nickname: user.nickname ?? user.username ?? user.name ?? 'Unknown',
        level: user.level,
        signature: user.signature || '',
        worldLevel: user.worldLevel,
        achievements: user.achievements,
        abyssFloor: user.towerFloorIndex != null && user.towerLevelIndex != null
            ? `${user.towerFloorIndex}-${user.towerLevelIndex}`
            : null,
    };

    const characters = (user.characters || []).map(char => {
        const avatarId = char.characterData?.id ?? char.characterId;
        return {
            ...summarizeCharacter(char),
            avatarId,
            imageUrl: getCharacterImageUrl(char),
        };
    });

    return { uid, playerInfo, characters };
}

function summarizeCharacter(char) {
    const data = char.characterData;

    const talents = {};
    try {
        for (const skill of char.skillLevels || []) {
            talents[skill.skill.name.get('en')] = skill.level;
        }
    } catch { /* best-effort, skip if shape differs */ }

    const stats = {};
    try {
        for (const sp of char.stats?.statProperties || []) {
            const formatted = formatStat(sp);
            if (formatted) stats[formatted.name] = formatted.value;
        }
    } catch { /* leave stats empty if the shape changed again */ }

    // Pulled from the confirmed-stable named accessors (char.stats.critRate
    // etc, not the localized display-name strings above) and computed here
    // in code rather than left to the AI, since ratio math is exactly the
    // kind of thing LLMs get subtly wrong.
    const derived = {};
    try {
        const cr = char.stats?.critRate?.value;
        const cd = char.stats?.critDamage?.value;
        if (cr != null) derived.critRatePercent = +(cr * 100).toFixed(1);
        if (cd != null) derived.critDamagePercent = +(cd * 100).toFixed(1);
        if (cr && cd) derived.rawCritRatio = `1 : ${(cd / cr).toFixed(2)}`; // artifact-only, excludes any conditional set-bonus crit
        if (char.stats?.chargeEfficiency?.value != null) derived.energyRechargePercent = +(char.stats.chargeEfficiency.value * 100).toFixed(1);
        if (char.stats?.elementMastery?.value != null) derived.elementMastery = Math.round(char.stats.elementMastery.value);
    } catch { /* leave derived empty if the shape changed again */ }

    const artifacts = (char.artifacts || []).map(art => {
        const subsSource = Array.isArray(art.substats) ? art.substats : (art.substats?.total ?? art.substats?.list ?? []);
        return {
            slot: art.artifactData?.equipTypeName?.get?.('en') ?? art.artifactData?.equipType ?? art.location,
            setName: art.artifactData?.set?.name?.get?.('en') ?? 'Unknown Set',
            level: art.level,
            mainStat: formatStat(art.mainstat),
            subStats: subsSource.map(formatStat).filter(Boolean),
        };
    });

    const weapon = char.weapon ? {
        name: char.weapon.weaponData?.name?.get?.('en') ?? 'Unknown Weapon',
        level: char.weapon.level,
        refinement: char.weapon.refinementRank ?? char.weapon.refinement,
        stats: (char.weapon.weaponStats || []).map(formatStat).filter(Boolean),
    } : null;

    // `element` was never confirmed via the debug dump - if it's a class
    // instance (not a plain string) it likely carries a circular back-ref to
    // the EnkaClient, which breaks JSON.stringify downstream. Only pass
    // through values we're sure are safe.
    function extractElement() {
        const el = data?.element ?? char.element;
        if (el == null) return null;
        if (typeof el === 'string') return el;
        try {
            return el.name?.get?.('en') ?? el.type ?? el.id ?? null;
        } catch {
            return null;
        }
    }

    return {
        name: data?.name?.get?.('en') ?? `Character ${char.characterId}`,
        element: extractElement(),
        level: char.level,
        constellation: char.unlockedConstellations ?? char.constellation ?? 0,
        friendship: char.friendship,
        talents,
        stats,
        derived,
        weapon,
        artifacts,
    };
}

// Build-card image: Enka doesn't render a composite "card" server-side, so we
// point the AI at the character's in-game showcase art as visual context.
// If you have a custom build-card renderer (e.g. via a headless browser
// screenshot of the Enka profile page), swap this out for that image URL.
function getCharacterImageUrl(char) {
    try {
        return char.characterData.splashImage?.url ?? char.characterData.icon?.url ?? char.costume?.icon?.url ?? null;
    } catch {
        return null;
    }
}

module.exports = { fetchEnkaProfile, getCharacterImageUrl };