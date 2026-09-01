const genshinDb = require('genshin-db');

const DB_VERSION = require('genshin-db/package.json').version;
const characterNames = genshinDb.characters('names', { matchCategories: true }) || [];

function normalize(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Stable, local facts are useful grounding for ordinary Genshin questions.
// This deliberately excludes volatile material such as banners, events, and
// current meta: those still go through live web research.
function buildGenshinDatabaseContext(message) {
    const normalizedMessage = ` ${normalize(message)} `;
    const matches = characterNames
        .filter(name => {
            const normalizedName = normalize(name);
            return normalizedName.length >= 3 && normalizedMessage.includes(` ${normalizedName} `);
        })
        .sort((a, b) => b.length - a.length)
        .slice(0, 2);

    if (matches.length === 0) return '';

    const facts = matches.map(name => {
        const character = genshinDb.characters(name);
        if (!character) return null;
        return `${character.name}: ${character.rarity}-star ${character.elementText} ${character.weaponText} from ${character.region}.`;
    }).filter(Boolean);

    return facts.length > 0
        ? `\n\nStable local Genshin data (genshin-db v${DB_VERSION}; not a source for current banners, events, or meta):\n${facts.join('\n')}`
        : '';
}

function getArtifactSetBonuses(setNames) {
    const seen = new Set();
    const bonuses = [];
    const missing = [];

    for (const rawName of setNames || []) {
        const name = String(rawName || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        const set = genshinDb.artifacts(name);
        if (!set?.effect2Pc && !set?.effect4Pc) {
            missing.push(name);
            continue;
        }
        bonuses.push(`${set.name}: 2pc - ${set.effect2Pc || 'none'} | 4pc - ${set.effect4Pc || 'none'}`);
    }

    return {
        text: bonuses.length > 0 ? bonuses.join('\n') : null,
        missing,
        sourceLabel: bonuses.length > 0 ? `genshin-db v${DB_VERSION}` : null,
    };
}

module.exports = { buildGenshinDatabaseContext, getArtifactSetBonuses };
