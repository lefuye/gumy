// Run this once after adding akasha.js to confirm the real response shape
// from akasha.cv's (undocumented, reverse-engineered) API for a real UID,
// e.g.:
//
//   node debug-akasha.js 778939683
//
// This CANNOT be tested from a sandboxed environment without outbound
// access to akasha.cv, so this is the actual verification step - run it
// against a UID you know has been submitted to akasha.cv at least once
// (visit https://akasha.cv, enter the UID, wait for it to process, then
// run this).
//
// If the shape printed here doesn't match what akasha.js expects
// (characterId / calculations[].ranking / .outOf / .result / .calculationId
// / .short / .name), patch summarizeAkashaCharacter() in akasha.js to match
// - same pattern as debug-enka.js for the Enka integration.

const { getAkashaCalculationsForUser, summarizeAkashaCharacter } = require('./akasha.js');

const uid = process.argv[2];
if (!uid) {
    console.error('Usage: node debug-akasha.js <uid>');
    process.exit(1);
}

async function main() {
    console.log(`Fetching Akasha calculations for UID ${uid}...\n`);
    const userCalcs = await getAkashaCalculationsForUser(uid);

    if (userCalcs.length === 0) {
        console.log('Got an empty list back. This means one of:');
        console.log('  1. This UID has never been submitted to akasha.cv - visit');
        console.log('     https://akasha.cv, enter the UID, wait for it to process, then retry.');
        console.log('  2. The request itself failed (check console output above for a logged error).');
        return;
    }

    console.log(`Got ${userCalcs.length} character entr${userCalcs.length === 1 ? 'y' : 'ies'} back.\n`);
    console.log('=== Raw shape of first entry (for verifying field names) ===');
    console.log(JSON.stringify(userCalcs[0], null, 2).slice(0, 2000));

    console.log('\n=== Parsed summary for every character on this UID ===');
    for (const entry of userCalcs) {
        const summary = summarizeAkashaCharacter(userCalcs, entry.characterId);
        if (!summary) {
            console.log(`characterId ${entry.characterId}: no valid ranking (missing ranking/outOf).`);
            continue;
        }
        console.log(`characterId ${entry.characterId} — ${summary.buildName}: top ${summary.topPercent}% (${summary.ranking}/${summary.outOf}), ${summary.damage.toLocaleString()} dmg${summary.otherVariantCount > 0 ? `, +${summary.otherVariantCount} other variant(s)` : ''}`);
        console.log(`  ${summary.leaderboardUrl}`);
    }
}

main().catch(err => {
    console.error('Debug script failed:', err.message);
    console.error(err.stack);
});
