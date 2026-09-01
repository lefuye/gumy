// Standalone test - does NOT touch your bot's runtime, just calls
// gpt-5.6-sol directly with a real Genshin query and prints every source it
// cites, so we can see with our own eyes which domains actually come back.
// Uses the exact same buildResearcherSystemPrompt logic Gumy already runs
// in production (via search-helpers.js), so this is a true test of the
// real pipeline, not a synthetic one.
//
// Run with: node test-search.js
// Optionally pass your own query: node test-search.js "best build for Mavuika"

require('dotenv/config');
const { OpenAI } = require('openai');
const { getWebResearch } = require('./search-helpers.js');

// The bot's existing configuration uses OPENAI_KEY. Keep the usual
// OPENAI_API_KEY fallback so this standalone verifier works in either setup.
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY || process.env.OPENAI_API_KEY });

const query = process.argv.slice(2).join(' ') || 'What is the current best artifact set and weapon build for Nefer in Genshin Impact?';

async function main() {
    console.log(`Query: "${query}"\n`);
    console.log('Calling gpt-5.6-sol...\n');

    const { text: resultText, sources } = await getWebResearch(
        query,
        openai,
        'Search the web for current, accurate Genshin Impact information. Be concise and factual - 2-4 sentences. Cite each factual claim using the sources you found.',
        { genshinTopic: true, maxOutputTokens: 1200 }
    );
    const text = resultText || '(no content returned)';

    console.log('=== Response text ===');
    console.log(text);

    console.log('\n=== Sources cited (this is the real evidence) ===');
    if (sources.length === 0) {
        console.log('No sources came back at all - either it didn\'t search, or returned zero citations.');
    } else {
        sources.forEach((s, i) => {
            const domain = new URL(s.url).hostname;
            const isTrusted = /game8\.co|prydwen\.gg|hoyolab\.com|hoyoverse\.com|keqingmains\.com|genshin-impact\.fandom\.com|icy-veins\.com|gematsu\.com|gamemarket\.gg/.test(domain);
            console.log(`${i + 1}. [${isTrusted ? 'TRUSTED' : 'other'}] ${domain}`);
            console.log(`   ${s.title}`);
            console.log(`   ${s.url}\n`);
        });
    }
}

main().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
