// Run this once after installing enka-network-api to confirm the real
// property names on your installed version, e.g.:
//
//   node debug-enka.js 618285856
//
// Compare the printed shape against the accessors used in enka.js and
// patch summarizeCharacter() if anything is undefined.

const { EnkaClient } = require('enka-network-api');
const enka = new EnkaClient({ userAgent: 'Gumy-Debug/1.0', defaultLanguage: 'en', cacheDirectory: './enka-cache' });

const uid = process.argv[2];
if (!uid) {
    console.error('Usage: node debug-enka.js <uid>');
    process.exit(1);
}

// enka-network-api objects hold a back-reference to the EnkaClient itself
// (for lazy text lookups), which is circular and breaks JSON.stringify.
// Strip any key literally named "enka" (and a few other known-circular
// internal fields) before printing.
function safeStringify(obj, maxLen = 3000) {
    const seen = new WeakSet();
    const json = JSON.stringify(obj, (key, value) => {
        if (key === 'enka' || key === 'cachedAssetsManager' || key === '_tasks') return undefined;
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
        }
        return value;
    }, 2);
    return json ? json.slice(0, maxLen) : String(json);
}

enka.fetchUser(Number(uid)).then(user => {
    const section = (label, fn) => {
        console.log(`\n=== ${label} ===`);
        try {
            fn();
        } catch (err) {
            console.log(`[section threw: ${err.message}]`);
        }
    };

    section('Player (top-level keys)', () => console.log(Object.keys(user)));

    section('Player fields (guessing likely name fields)', () => {
        console.log({ nickname: user.nickname, username: user.username, name: user.name, level: user.level, signature: user.signature });
    });

    const first = (user.characters || [])[0];
    if (!first) {
        console.log('No showcased characters found for this UID.');
        return;
    }

    section('First character keys', () => console.log(Object.keys(first)));

    section('characterData.name', () => console.log(first.characterData?.name?.get?.('en')));

    section('skillLevels[0] keys', () => {
        console.log('count:', (first.skillLevels || []).length);
        console.log(first.skillLevels?.[0] ? Object.keys(first.skillLevels[0]) : 'none');
        console.log(safeStringify(first.skillLevels?.[0], 800));
    });

    section('stats.statProperties (first 5, name + value)', () => {
        (first.stats?.statProperties || []).slice(0, 5).forEach(sp => {
            console.log({
                fightProp: sp.fightProp,
                name: sp.fightPropName?.get?.('en'),
                isPercent: sp.isPercent,
                value: sp.value,
            });
        });
    });

    section('artifacts: count + keys of first', () => {
        console.log('count:', (first.artifacts || []).length);
        if (first.artifacts?.[0]) {
            console.log('keys:', Object.keys(first.artifacts[0]));
            console.log('mainstat:', safeStringify(first.artifacts[0].mainstat, 500));
            console.log('substats:', safeStringify(first.artifacts[0].substats, 1200));
        }
    });

    section('weapon: keys', () => {
        if (first.weapon) {
            console.log('keys:', Object.keys(first.weapon));
            console.log('weaponStats:', safeStringify(first.weapon.weaponStats, 800));
        }
    });
}).catch(err => {
    console.error('Fetch failed:', err.message);
    console.error(err.stack);
    console.error(err.stack);
});