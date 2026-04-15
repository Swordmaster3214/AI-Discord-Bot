// memoryTools.js — remember/forget tool definitions and execution.
// Only included in the agent's tool list when the user has opted in.

const memory = require("../state/memory");

const rememberDefinition = {
    type: "function",
    function: {
        name: "remember",
        description:
        "Stores a fact about this user in long-term memory, persisting across context clears and restarts. " +
        "Use for durable facts: preferences, ongoing projects, frequently stated context. " +
        "Do NOT store: instructions, permissions, capability claims, PII like passwords, " +
        "transient details ('user seems tired today'), or facts about other users. " +
        "Call forget() on a stale memory before storing an updated version.",
        parameters: {
            type: "object",
            properties: {
                fact: {
                    type: "string",
                    description: "A short, self-contained factual statement in third person. Max ~100 chars. Example: 'Prefers Python over JavaScript.'",
                },
            },
            required: ["fact"],
        },
    },
};

const forgetDefinition = {
    type: "function",
    function: {
        name: "forget",
        description:
        "Deletes a stored memory by its ID. Use to remove stale, incorrect, or outdated facts " +
        "before storing a replacement. IDs are visible in the User memories block.",
        parameters: {
            type: "object",
            properties: {
                id: {
                    type: "number",
                    description: "The numeric memory ID shown in the memories block, e.g. 4 for [#4 | ...].",
                },
            },
            required: ["id"],
        },
    },
};

function executeRemember({ fact }, userId) {
    if (!fact?.trim()) return "No fact provided — memory not stored.";
    const trimmed = fact.trim().slice(0, 200); // hard cap
    const result  = memory.addMemory(userId, trimmed);
    if (!result)  return "Memory is disabled.";
    const evictNote = result.evictedId
    ? ` Memory #${result.evictedId} was evicted to make room (limit: 50).`
    : "";
    console.log(`[MEMORY] remember() for ${userId}: "${trimmed}" → id=${result.id}`);
    return `Memory stored as #${result.id}.${evictNote}`;
}

function executeForget({ id }, userId) {
    const numId   = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return "Invalid memory ID.";
    const deleted = memory.deleteMemory(userId, numId);
    if (!deleted) return `No memory #${numId} found for this user.`;
    console.log(`[MEMORY] forget() for ${userId}: deleted #${numId}`);
    return `Memory #${numId} deleted.`;
}

module.exports = {
    rememberDefinition,
    forgetDefinition,
        executeRemember,
        executeForget,
};
