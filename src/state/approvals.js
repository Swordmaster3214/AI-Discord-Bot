// Pending exec approval requests.
// Map<id, { resolve, command, timer, source, username }>
const pendingApprovals = new Map();
let nextApprovalId = 1;

const APPROVAL_TIMEOUT_MS    = 5 * 60 * 1000; // auto-deny after 5 minutes
const APPROVAL_CONTEXT_LINES = 6;              // recent messages shown to owner

// Splits text into ≤maxLen chunks on newline boundaries.
function splitText(text, maxLen = 1900) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let current = "";
    for (const line of text.split("\n")) {
        const candidate = current ? current + "\n" + line : line;
        if (candidate.length <= maxLen) { current = candidate; continue; }
        if (current) chunks.push(current);
        current = line.length <= maxLen ? line : line.slice(0, maxLen);
    }
    if (current) chunks.push(current);
    return chunks;
}

// Sends a long message to owner in chunks.
async function ownerSend(owner, text) {
    for (const chunk of splitText(text)) await owner.send(chunk);
}

// Extracts a readable context excerpt from a message history array.
function buildContextExcerpt(messages) {
    const recent = messages
    .filter(m => m.role !== "system")
    .slice(-APPROVAL_CONTEXT_LINES);
    if (recent.length === 0) return "_No prior messages._";
    return recent.map(m => {
        const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `**${m.role}:** ${raw.slice(0, 300)}`;
    }).join("\n");
}

// Creates a pending approval, sets the auto-deny timer, and DMs the owner.
// client is passed in to avoid a circular dependency with the discord layer.
async function createPendingApproval(command, source, username, messages, client) {
    const id = String(nextApprovalId++);
    let resolve;
    const promise = new Promise(r => { resolve = r; });

    const timer = setTimeout(async () => {
        if (!pendingApprovals.has(id)) return;
        console.log(`[APPROVE] Request ${id} timed out — auto-denying.`);
        resolvePendingApproval(id, "Denied: approval request timed out.");
        try {
            const owner = await client.users.fetch(process.env.OWNER_ID);
            await owner.send(
                `⏱️ Approval request **${id}** timed out and was auto-denied.\n` +
                `**Source:** ${source}\n` +
                `**Command:** \`${command}\``
            );
        } catch (err) {
            console.error(`[APPROVE] Could not DM owner on timeout: ${err.message}`);
        }
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(id, { resolve, command, timer, source, username });

    try {
        const owner = await client.users.fetch(process.env.OWNER_ID);
        const excerpt = buildContextExcerpt(messages);
        await ownerSend(owner,
                        `⚠️ **Exec approval request** — ID \`${id}\`\n` +
                        `**From:** ${username} | **Location:** ${source}\n` +
                        `**Command:** \`${command}\`\n` +
                        `**Times out in:** ${APPROVAL_TIMEOUT_MS / 60000} minutes\n\n` +
                        `**Recent context:**\n${excerpt}\n\n` +
                        `Use \`/approve decide\` with ID \`${id}\` to accept or deny.`
        );
    } catch (err) {
        console.error(`[APPROVE] Could not DM owner: ${err.message}`);
    }

    return { id, promise };
}

function resolvePendingApproval(id, result) {
    const entry = pendingApprovals.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(result);
    pendingApprovals.delete(id);
    return true;
}

module.exports = {
    pendingApprovals, APPROVAL_TIMEOUT_MS,
    createPendingApproval, resolvePendingApproval, buildContextExcerpt,
};
