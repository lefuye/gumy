// Per-user daily usage quotas. Exists specifically so one user's usage
// (accidental or a troll spamming a command) can't drain the bot's API
// budget for everyone else - and per explicit design requirement, this is
// done TRANSPARENTLY: hitting a limit always says so clearly and visibly,
// never silently degrades in a way that reads as "Gumy got dumb."
//
// Resets daily at midnight UTC - same UTC-date convention already used by
// search-helpers.js's todayDateString(), for consistency.
//
// Numbers (tune these directly if they feel wrong in practice):
// - /analyze: 1/day. Each run is 2 research calls + 1 analysis call PER
//   CHARACTER, plus a full Enka fetch - genuinely the most expensive single
//   command in the bot, so it gets the tightest cap.
// - /search: 2/day. Cheaper per-use (1-2 research calls + 1 answer), no
//   multi-character amplification risk like /analyze has - but still a
//   deliberate ask for a search, same spirit as /analyze being capped low.
// - chat_search: 5/day. This is regular conversation that happens to
//   classify as "search" or "genshin_build" - kept in line with the other
//   deliberate-search-cost quotas (/search, /analyze) rather than sitting
//   well above them.
// - normal_message: 10/day. Regular non-search, non-RP chat replies.
// - story_message: 10/day. Collaborative fiction / RP turns - already runs
//   on the cheaper nano model with a smaller context window, but RP tends
//   to run long (many back-and-forth turns per session), so it still gets
//   its own explicit daily cap rather than being lumped into normal_message.
const LIMITS = {
    analyze: 1,
    search_command: 2,
    chat_search: 5,
    normal_message: 10,
    story_message: 10,
};

function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

function setupQuotaTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS usage_quotas (
            user_id TEXT NOT NULL,
            quota_type TEXT NOT NULL,
            quota_date TEXT NOT NULL,
            count INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, quota_type)
        )
    `);
}

// Checks remaining room and, if any, ATOMICALLY consumes one use in the
// same call - returns { allowed: true, used, limit, remaining }. If the
// user is already at the limit, returns { allowed: false, ... } WITHOUT
// consuming anything - a blocked attempt doesn't cost a slot.
function checkAndConsumeQuota(db, userId, quotaType) {
    const limit = LIMITS[quotaType];
    if (limit == null) throw new Error(`Unknown quota type: ${quotaType}`);

    const today = todayUTC();
    const row = db.prepare('SELECT count, quota_date FROM usage_quotas WHERE user_id = ? AND quota_type = ?').get(userId, quotaType);

    // No row yet, or the row is from a previous UTC day - treat as a fresh
    // day regardless of what's stored (this IS the daily reset - there's
    // no separate cleanup job, the reset just happens lazily on next use).
    const currentCount = (row && row.quota_date === today) ? row.count : 0;

    if (currentCount >= limit) {
        return { allowed: false, used: currentCount, limit, remaining: 0 };
    }

    const newCount = currentCount + 1;
    db.prepare(`
        INSERT INTO usage_quotas (user_id, quota_type, quota_date, count) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, quota_type) DO UPDATE SET quota_date = excluded.quota_date, count = excluded.count
    `).run(userId, quotaType, today, newCount);

    return { allowed: true, used: newCount, limit, remaining: limit - newCount };
}

// Read-only peek (doesn't consume) - for showing status without using a slot.
function peekQuota(db, userId, quotaType) {
    const limit = LIMITS[quotaType];
    const today = todayUTC();
    const row = db.prepare('SELECT count, quota_date FROM usage_quotas WHERE user_id = ? AND quota_type = ?').get(userId, quotaType);
    const used = (row && row.quota_date === today) ? row.count : 0;
    return { used, limit, remaining: Math.max(0, limit - used) };
}

// Standard, loud, un-diminished message for when a limit is actually hit -
// deliberately NOT small-text/subtext, since this needs to be impossible to
// miss and read as "quota," never as "Gumy being dumb."
function limitHitMessage(quotaType, result) {
    const labels = {
        analyze: '/analyze',
        search_command: '/search',
        chat_search: 'search-triggering chat messages',
        normal_message: 'normal chat messages',
        story_message: 'story/RP chat messages',
    };
    return `**Hit today's usage limit for ${labels[quotaType]} (${result.used}/${result.limit}).** This resets at midnight UTC. Not a bug, not Gumy being slow - just a real cap so one person's usage can't eat the whole bot's budget for everyone else.`;
}

// Whitelist check - exempt users/roles skip quotas entirely (not tracked,
// not consumed, unlimited use). Deliberately Discord-agnostic (just takes
// plain ID arrays) so it works the same from a message handler or an
// interaction handler without duplicating logic.
function isQuotaExempt(userId, roleIds, whitelistUserIds, whitelistRoleIds) {
    if (whitelistUserIds.includes(userId)) return true;
    if (roleIds && roleIds.length > 0 && whitelistRoleIds.length > 0) {
        return roleIds.some(r => whitelistRoleIds.includes(r));
    }
    return false;
}

module.exports = { setupQuotaTable, checkAndConsumeQuota, peekQuota, limitHitMessage, isQuotaExempt, LIMITS };