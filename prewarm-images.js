// Pre-populates the local thumbnail cache (image-cache.js) with a tiny
// thumbnail of EVERY released character's splash art, so /analyze never
// pays a cold fetch at runtime.
//
// Reads the game-data JSON that Enka already caches locally under
// ./enka-cache/data (no metadata network calls needed) and derives each
// character's splash-art filename exactly the way enka-network-api does:
//   nameId = iconName minus the "UI_AvatarIcon_" prefix
//   file   = UI_Gacha_AvatarImg_<nameId>.png
// Characters are filtered to those listed in AvatarCodexExcelConfigData
// (i.e. actually obtainable/released) - the raw avatar table also contains
// NPCs and test entries whose images don't exist on any mirror.
//
// Mirrors are shared with image-cache.js (enka.network first - homdgcat,
// the library's default top-priority host, has been unreachable). Already-
// cached thumbnails are skipped, so this is safe to re-run after patches -
// it only fills gaps for newly added characters.
//
// Run with: node prewarm-images.js

const fs = require('fs');
const path = require('path');
const { cacheThumbnail, IMAGE_MIRRORS, CACHE_DIR } = require('./image-cache.js');

const DATA_DIR = path.join(__dirname, 'enka-cache', 'data');

async function main() {
    const avatars = require(path.join(DATA_DIR, 'AvatarExcelConfigData.json'));
    const codex = require(path.join(DATA_DIR, 'AvatarCodexExcelConfigData.json'));
    const releasedIds = new Set(Object.keys(codex).map(Number));

    const targets = Object.values(avatars)
        .filter(a => releasedIds.has(a.id) && typeof a.iconName === 'string' && a.iconName.startsWith('UI_AvatarIcon_'))
        .map(a => ({
            key: String(a.id),
            fileName: `UI_Gacha_AvatarImg_${a.iconName.slice('UI_AvatarIcon_'.length)}`,
        }));

    console.log(`${targets.length} released character(s) found in local game data.`);

    // Count what's already cached so we can skip it without fetching.
    let alreadyCached = 0;
    for (const t of targets) {
        try {
            await fs.promises.access(path.join(CACHE_DIR, `${t.key}.jpg`));
            alreadyCached++;
        } catch { /* not cached */ }
    }
    console.log(`${alreadyCached} already cached, ${targets.length - alreadyCached} to fetch.`);

    let ok = 0;
    let failed = [];
    const CONCURRENCY = 4;
    const queue = targets.filter(t => !fs.existsSync(path.join(CACHE_DIR, `${t.key}.jpg`)));

    async function worker() {
        while (queue.length > 0) {
            const target = queue.shift();
            const urls = IMAGE_MIRRORS.map(build => build(target.fileName));
            const result = await cacheThumbnail(target.key, urls);
            if (result) {
                ok++;
                process.stdout.write(`ok   ${target.key} (${target.fileName})\n`);
            } else {
                failed.push(target);
                process.stdout.write(`FAIL ${target.key} (${target.fileName})\n`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\nDone: ${ok} fetched, ${alreadyCached} previously cached, ${failed.length} failed.`);
    if (failed.length > 0) {
        console.log('Failed (likely unreleased/placeholder entries or all mirrors down):');
        failed.forEach(t => console.log(`  - ${t.key}: ${t.fileName}`));
    }
}

main().catch(err => {
    console.error('Prewarm failed:', err);
    process.exit(1);
});
