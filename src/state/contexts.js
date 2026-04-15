const { getGuildConfig }  = require("./config");
const { getSystemPrompt }  = require("../core/systemPrompt");

// In-memory conversation histories keyed by context key.
const contexts = new Map();

// Users who have seen the exec consent notice this session (resets on restart).
const dmExecConsentSeen = new Set();

// Models that returned a 400 on think:true this session — limits owner DM to once per model.
const unsupportedThinkingModels = new Set();

function getContext(key, channelConfig) {
    if (!contexts.has(key)) {
        contexts.set(key, [{ role: "system", content: getSystemPrompt(channelConfig) }]);
    }
    return contexts.get(key);
}

function clearContext(key, channelConfig) {
    contexts.set(key, [{ role: "system", content: getSystemPrompt(channelConfig) }]);
    console.log(`[CONTEXT] Cleared: ${key}`);
}

function clearGuildContexts(guildId) {
    const guild = getGuildConfig(guildId);
    contexts.delete(`guild:${guildId}`);
    for (const channelId of Object.keys(guild.channels ?? {})) {
        contexts.delete(`channel:${channelId}`);
    }
    console.log(`[CONTEXT] Cleared all contexts for guild ${guildId}.`);
}

// Refreshes the system prompt at index 0 to reflect current channel config.
// Called at the start of every handleTrigger to stay in sync with config changes.
function syncSystemPrompt(key, channelConfig) {
    const msgs = contexts.get(key);
    if (msgs) msgs[0] = { role: "system", content: getSystemPrompt(channelConfig) };
}

module.exports = {
    contexts, dmExecConsentSeen, unsupportedThinkingModels,
    getContext, clearContext, clearGuildContexts, syncSystemPrompt,
};
