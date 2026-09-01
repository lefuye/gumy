## MADE FOR THY LEFYE CENTRAL. PROBABLY PRONE TO BUGS (though shouldnt). JOIN: https://discord.gg/hFUnpTV7HT 

## What this is

"Gumy"; a Discord bot for a mixed Linux/Genshin community. Plain CommonJS Node.js, no build step, no linter, no test suite. Runs a single long-lived process (`node index.js`).

## Commands

```bash
node index.js            # run the bot
node slashes.js          # register slash commands (guild-scoped; run after adding/changing commands)
node test-search.js "query"   # standalone check of the real web-search pipeline + which domains it cites
node debug-enka.js <uid>      # dump raw Enka character object when enka.js accessors break
node debug-akasha.js     # dump raw Akasha API response
node prewarm-images.js   # download+resize thumbnails for all released characters into ./image-cache (safe to re-run; skips cached)
```

Requires `.env`: `TOKEN` (Discord), `OPENAI_KEY`, optional `HOME_CHANNEL_IDS` (comma-separated channel IDs that get replies without @mention), optional `QUOTA_WHITELIST_USERS` / `QUOTA_WHITELIST_ROLES` (comma-separated Discord IDs, skip all quotas). `slashes.js` additionally needs `BOT_ID` / `GUILD_ID` at registration time. See `.env.example`.

## Architecture

### Message flow (index.js)

Every non-command message in the home channel (or any channel where the bot is @mentioned) goes through a pipeline:

1. **Classify** (`classifyMessage`); a cheap model call returns one word: `search` | `genshin_build` | `story` | `normal`. This drives everything downstream.
2. **Quota gate** (`quota.js`); each category has its own daily pool (UTC reset). Search-needing messages that hit their cap get *downgraded* (skip web search, fall back to the cheap model, loud notice appended); normal/story messages that hit theirs get *blocked outright*.
3. **Context gathering**; depending on classification: refined multi-query web search (`search-helpers.js`), parallel targeted Genshin-build research (meta/artifacts/team-comps), local genshin-db character facts (`genshin-data.js`), reply-chain fetch, user profile + community snapshot from DB.
4. **Reply generation**; model tier by class: `story` or quota-capped → nano (cheap); everything else → luna. Story also gets a smaller context window and tighter token cap.
5. **Post-processing**; hard-guarantee @mention of the author (prepended if the model didn't do it naturally), banner links appended for Genshin banner questions, sources block, trace block, then split across messages at Discord's 2000-char limit.
6. **Persistence**; conversation turn always saved; profile extraction sampled (~30% of turns) and never gates memory-saving; background history compression when over the char cap.

Slash commands (`/analyze`, `/search`, `/link`, `/quota`, `/skibidi`) bypass `messageCreate`, so they persist their results into history explicitly (`rememberConversation`/`saveHistoryMessages`). Registering a new command means editing **both** `slashes.js` and the `interactionCreate` handler in `index.js`.

### State (SQLite, `gumy.db`, better-sqlite3)

Three tables set up at startup: `users` (per-user profile JSON + conversation history JSON), `uid_links` (Discord user ↔ Genshin UID for `/analyze`), `usage_quotas`. Quota daily reset is lazy; no cron, just date comparison on next use. All writes are synchronous/better-sqlite3 style.

### Cross-file conventions

- **Persona** lives only in `gumy-persona.js` (`GUMY_PERSONA`); every AI call site imports the same string so the voice can't drift between chat, `/search`, and `/analyze`.
- **Search/research** funnels through `search-helpers.js`: `buildResearcherSystemPrompt` injects today's date plus source-quality rules; `runMultiSearch` splits a message into up to 2 distinct questions and merges evidence + deduped sources. Sources come from Responses-API annotations (`extractSources`).
- **Per-invocation logger** (`createLogger()` pattern, duplicated in index.js / analyze-command.js / search-command.js): prints tagged lines to console AND collects a trace array rendered as small-text `-#` lines appended to that specific reply. Concurrent users must never share one trace. Trace lines carry stage metadata only; never prompt text, history, or completion content.
- **Math stays in code**: percentile brackets (`topPercentLabel`), crit ratios, etc. are computed exactly in JS and handed to the model as precomputed values, on the theory LLMs get rounding/ratio math subtly wrong.
- Error messages to users consistently distinguish "real backend failure" from "couldn't find an answer" so quota/API problems never read as Gumy being dumb.

### External integrations and their sharp edges

- **Enka Network** (`enka.js`, enka-network-api): game-data cache in `./enka-cache`, refreshed via `activateAutoCacheUpdater({ instant: true })`. Do NOT also call `fetchAllContents()`; they race for the same fetch lock and hard-crash. Library property names have shifted across majors; if fields come back undefined, run `node debug-enka.js <uid>` and fix accessors rather than guessing. Enka objects can carry circular refs back to the client; pass through only sanitized fields (`safeStringify` in analyze-command.js exists for this).
- **Character images** (`image-cache.js`): `/analyze` vision input comes from a local disk cache of ~320px JPEG thumbnails in `./image-cache/`, keyed by avatarId (stable across mirror changes); NOT from live CDN fetches. The library's default top-priority image host is homdgcat.wiki, which was observed completely unreachable on 2026-08-23, so mirror order puts enka.network first (`mirrorUrlsFor` derives the chain from any UI asset URL). Cold miss = one fetch + resize via `sharp`, cached forever after; run `node prewarm-images.js` to fill the whole roster (~120 chars ≈ 1 MB). Thumbnails are deliberately small; vision only needs "which character is this"; the stat JSON carries the numbers.
- **Akasha** (`akasha.js`, akasha.cv): unofficial reverse-engineered API, no stability guarantee; fail soft everywhere. Two verified-live constraints (2026-08-22): the User-Agent must stay `'akasha-py'` (custom UAs get a Cloudflare challenge), and requests must use node's `https` module, not global `fetch`/undici (Cloudflare fingerprints the TLS stack, and undici trips it even with identical headers). An empty calculation list is normal (UID never submitted), not an error.
- **Genshin data** (`genshin-data.js`, genshin-db): local, stable facts only; never banners/meta, those go through live search. `GENSHIN_CURRENT_PATCH` in search-helpers.js is deliberately `null`; do not hard-code a patch number there, it silently becomes false ground truth after each patch.

## Notes

- Models are referenced by tier name throughout: `gpt-5.6-luna` (main/search), `gpt-5.4-mini` (classifier/query-refinement/profiler), `gpt-5.4-nano` (cheap fallback). Several calls need explicit low reasoning effort or tight token budgets; default reasoning settings were observed to consume the whole completion budget and return empty content (see comments in analyze-command.js).
- `CHANNELS` (home channel IDs) comes from the `HOME_CHANNEL_IDS` env var; the application/guild IDs used by `slashes.js` come from `BOT_ID` / `GUILD_ID`. No IDs are hard-coded.
