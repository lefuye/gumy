const { GUMY_PERSONA } = require('./gumy-persona.js');
const {
    todayDateString,
    isGenshinRelated,
    isLeakQuestion,
    refineSearchQueries,
    runMultiSearch,
    appendBannerLinksIfNeeded,
    formatSources,
} = require('./search-helpers.js');

// Per-invocation logger - /search can run concurrently for different users,
// and a shared trace array would mix their entries together.
function createLogger() {
    const trace = [];
    const log = (...args) => {
        const line = args.join(' ');
        console.log(`[search ${new Date().toISOString().slice(11, 19)}]`, line);
        trace.push(line);
    };
    log.trace = trace;
    log.block = () => trace.length > 0 ? `\n\n${trace.map(l => `-# ${l}`).join('\n')}` : '';
    return log;
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

async function handleSearchCommand(interaction, { openai, rememberConversation }) {
    const log = createLogger();
    const rawQuery = interaction.options.getString('query', true);
    log(`/search invoked by ${interaction.user.tag}: "${rawQuery}"`);
    await interaction.deferReply();

    const genshinRelated = isGenshinRelated(rawQuery);

    // Same paraphrasing step as regular chat search - detects if there are
    // actually two distinct questions and searches both instead of merging
    // them into one and silently dropping whichever loses the merge.
    const refinedQueries = await refineSearchQueries(rawQuery, openai);
    log(`Refined (${refinedQueries.length}): ${refinedQueries.map(q => `"${q}"`).join(', ')}`);

    const searchResult = await runMultiSearch(refinedQueries, openai, {
        genshinTopic: genshinRelated,
        allowLeakSources: genshinRelated && isLeakQuestion(rawQuery),
    });

    let evidenceBlock;
    if (searchResult.text) {
        evidenceBlock = `Today's date is ${todayDateString()}. The following is web research gathered specifically for this request - treat it as supporting evidence, not settled truth. Evaluate its relevance, recency, and consistency yourself: don't repeat a claim that reads outdated, contradicts itself, or isn't actually backed by this text. If it's actually an old, undated, or unrelated page, don't present it as an answer - say plainly that a current source wasn't found. Don't invent or guess anything beyond it.${searchResult.queryCount > 1 ? ' IMPORTANT: the original request asked MULTIPLE distinct questions, and this evidence covers each one separately - make sure your reply actually addresses every question asked, don\'t just answer one and drop the rest.' : ''}\n\n${searchResult.text}`;
        if (searchResult.sources.length > 0) {
            evidenceBlock += `\n\nIf natural, mention where this came from. Sources: ${searchResult.sources.slice(0, 3).map(s => s.url).join(', ')}`;
        } else {
            evidenceBlock += `\n\nNo confirmed current sources came back. IMPORTANT: this does NOT mean you should refuse to answer or tell the person to go verify it themselves and stop there. Give your best general answer, hedge the specifics you can't confirm, and point them somewhere they can check in one click.`;
        }
    } else {
        evidenceBlock = `Today's date is ${todayDateString()}. The web search itself failed to return anything (technical issue, not a lack of information). Be upfront that the search didn't come back with results this time, give your best general-knowledge answer if you have one, and suggest they try again or rephrase - don't pretend you have current info you don't.`;
    }

    log(`Search complete - ${searchResult.text ? 'got evidence' : 'no evidence'}, ${searchResult.sources.length} source(s). Generating final reply...`);

    const response = await openai.chat.completions.create({
        model: 'gpt-5.6-luna',
        messages: [
            {
                role: 'system',
                content: `${GUMY_PERSONA}\n\nSomeone used your /search command to directly ask you to look something up - so actually answer using the evidence below, in your own voice. Don't say you can't search - you just did. Plain conversational text, no markdown headers, no JSON.`
            },
            {
                role: 'user',
                content: `Original request: "${rawQuery}"\n\n${evidenceBlock}`
            }
        ],
        max_completion_tokens: 600
    });

    let content = response.choices?.[0]?.message?.content?.trim() || 'Couldn\'t put together an answer for that - try rephrasing?';

    const authorMentionTag = `<@${interaction.user.id}>`;
    if (!content.includes(authorMentionTag)) {
        content = `${authorMentionTag} ${content}`;
    }

    content = appendBannerLinksIfNeeded(content, rawQuery);
    content += formatSources(searchResult.sources);
    content += log.block();

    // Slash commands do not pass through messageCreate, so persist this
    // interaction explicitly for later follow-up questions.
    if (rememberConversation) {
        rememberConversation(interaction.user.id, interaction.user.username, `/search ${rawQuery}`, content);
        log('Saved /search result to conversation history.');
    }

    const chunks = splitMessage(content);
    await interaction.editReply({ content: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] });
    }
    log('Reply sent.');
}

module.exports = { handleSearchCommand };
