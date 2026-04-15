const { handleTrigger, splitMessage } = require("./agentLoop");
const { dmExecConsentSeen }           = require("../state/contexts");

// ── Ollama concurrency semaphore ──────────────────────────────────────────────
const OLLAMA_CONCURRENCY = parseInt(process.env.OLLAMA_CONCURRENCY ?? "2", 10);
let ollamaSlots = OLLAMA_CONCURRENCY;
const ollamaWaiters = [];

function acquireOllamaSlot() {
    if (ollamaSlots > 0) { ollamaSlots--; return Promise.resolve(); }
    return new Promise(resolve => ollamaWaiters.push(resolve));
}

function releaseOllamaSlot() {
    if (ollamaWaiters.length > 0) ollamaWaiters.shift()();
    else ollamaSlots++;
}

// ── Per-user cooldown ─────────────────────────────────────────────────────────
const activeUserContexts = new Set();

// ── Per-context queues ────────────────────────────────────────────────────────
const contextQueues  = new Map();
const activeContexts = new Set();

async function enqueue(job) {
    const key = job.contextKey;
    const userKey = job.userId ? `${job.userId}:${key}` : null;

    if (userKey && activeUserContexts.has(userKey)) {
        await job.notifyFn("⏳ Your previous message is still being processed. Please wait.");
        return;
    }

    if (!contextQueues.has(key)) contextQueues.set(key, []);
    contextQueues.get(key).push(job);

    const depth = contextQueues.get(key).length;
    if (depth > 1) {
        await job.notifyFn(`🕐 **${depth - 1}** message(s) ahead of yours in this channel.`);
    }

    if (!activeContexts.has(key)) processContext(key);
}

async function processContext(key) {
    const queue = contextQueues.get(key);
    if (!queue || queue.length === 0) {
        activeContexts.delete(key);
        contextQueues.delete(key);
        return;
    }

    activeContexts.add(key);
    const job = queue.shift();
    const userKey = job.userId ? `${job.userId}:${key}` : null;
    if (userKey) activeUserContexts.add(userKey);

    console.log(`[QUEUE] context=${key} | queued=${queue.length} | active=${activeContexts.size}`);

    // DM exec consent notice — shown once per user per session when exec is enabled.
    const isDmContext = key.startsWith("dm:");
    if (isDmContext && job.channelConfig.execEnabled && job.userId && !dmExecConsentSeen.has(job.userId)) {
        dmExecConsentSeen.add(job.userId);
        try {
            const channel = await job.getChannel();
            await channel.send(
                `⚠️ **Heads up:** exec (shell commands) is enabled in this DM.\n` +
                `If you ask the bot to run a command, an approval request will be sent to the bot owner — ` +
                `this includes recent messages from our conversation as context for the decision.\n` +
                `To disable exec, use \`/config exec false\`.`
            );
        } catch (err) {
            console.error(`[CONSENT] Could not send DM exec notice: ${err.message}`);
        }
    }

    await acquireOllamaSlot();
    const channel = await job.getChannel();
    const typing  = startTyping(channel);
    try {
        // handleTrigger returns { reply, thinking, memoriesInjected }.
        const result = await handleTrigger(
            job.content, job.replyFn, typing, job.channelConfig,
            job.contextKey, job.username, job.sourceMeta ?? {},
            job.images ?? [], job.client, job.userId,
        );
        if (result) await job.sendResult(result);
    } catch (err) {
        typing.stop();
        console.error(`[QUEUE] Job error on context ${key}: ${err.message}`);
        await job.sendResult({ reply: `❌ An error occurred: ${err.message}`, thinking: "", memoriesInjected: false });
    } finally {
        releaseOllamaSlot();
        if (userKey) activeUserContexts.delete(userKey);
    }

    processContext(key);
}

// ── Typing indicator ──────────────────────────────────────────────────────────
function startTyping(channel) {
    channel.sendTyping().catch(() => {});
    const interval = setInterval(() => channel.sendTyping().catch(() => {}), 5000);
    return {
        stop:    () => clearInterval(interval),
        restart: () => { clearInterval(interval); channel.sendTyping().catch(() => {}); },
    };
}

module.exports = { enqueue, startTyping, splitMessage, contextQueues, activeContexts };
