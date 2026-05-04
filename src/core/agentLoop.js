const { ollamaChat }      = require("./ollamaClient");
const { getContext, syncSystemPrompt } = require("../state/contexts");
const { setGuildValue, setDmValue }    = require("../state/config");
const execTool    = require("../tools/exec");
const searchTool  = require("../tools/search");
const memoryTools = require("../tools/memoryTools");
const memory      = require("../state/memory");
const fileTool    = require("../tools/file");
const runCodeTool = require("../tools/runCode");
const fetchTool   = require("../tools/fetch");

const MAX_ITERATIONS = 10;

// ── Tool registry ─────────────────────────────────────────────────────────────
const TOOLS = {
    exec:       { def: execTool.definition,              exec: (args, ctx)        => execTool.execute(args, ctx) },
    search:     { def: searchTool.definition,            exec: (args)             => searchTool.execute(args) },
    remember:   { def: memoryTools.rememberDefinition,   exec: (args, _ctx, uid)  => memoryTools.executeRemember(args, uid) },
    forget:     { def: memoryTools.forgetDefinition,     exec: (args, _ctx, uid)  => memoryTools.executeForget(args, uid) },
        file:       { def: fileTool.definition,              exec: (args)             => fileTool.execute(args) },
        run_code:   { def: runCodeTool.definition,           exec: (args)             => runCodeTool.execute(args) },
        fetch_page: { def: fetchTool.definition,             exec: (args)             => fetchTool.execute(args) },
};

// Builds the tools array for Ollama based on channel config and memory opt-in.
function buildToolDefinitions(channelConfig, execAllowed, userId) {
    const enabled = [];
    const t = channelConfig.tools ?? {};
    if (execAllowed && t.exec)                                    enabled.push("exec");
    if (t.search)                                                 enabled.push("search");
    if (t.file)                                                   enabled.push("file");
    if (t.runCode)                                                enabled.push("run_code");
    if (t.fetch)                                                  enabled.push("fetch_page");
    if (memory.ENABLED && userId && memory.isUserEnabled(userId)) enabled.push("remember", "forget");
    return enabled.map(k => TOOLS[k].def);
}

// Splits a string into Discord-safe chunks (≤2000 chars).
// Tracks open fenced code blocks and closes/reopens them across boundaries.
function splitMessage(text, size = 2000) {
    if (text.length <= size) return [text];

    const chunks  = [];
    const lines   = text.split("\n");
    let current   = "";
    let inBlock   = false;
    let blockLang = "";

    const flush = () => {
        if (!current) return;
        const out = inBlock ? current + "\n```" : current;
        chunks.push(out);
        current = inBlock ? "```" + blockLang : "";
    };

    for (const line of lines) {
        const fenceMatch = line.match(/^(`{3,}|~{3,})(\w*)/);
        if (fenceMatch) {
            if (inBlock) { inBlock = false; blockLang = ""; }
            else         { inBlock = true;  blockLang = fenceMatch[2] ?? ""; }
        }

        const candidate = current ? current + "\n" + line : line;

        if (candidate.length <= size) { current = candidate; continue; }

        flush();

        if (line.length <= size) {
            current = inBlock ? "```" + blockLang + "\n" + line : line;
            continue;
        }

        const words = line.split(" ");
        let buf = inBlock ? "```" + blockLang : "";
        for (const word of words) {
            const attempt = buf ? buf + " " + word : word;
            if (attempt.length <= size) {
                buf = attempt;
            } else {
                chunks.push(inBlock ? buf + "\n```" : buf);
                buf = inBlock ? "```" + blockLang + " " + word : word;
            }
        }
        current = buf;
    }

    flush();
    return chunks.filter(c => c.length > 0);
}

// ── Agent loop ────────────────────────────────────────────────────────────────
async function runAgent(messages, replyFn, typing, channelConfig, meta = {}, client, userId, signal = null, disableThinkingFn = null) {
    let execAllowed       = channelConfig.tools?.exec     ?? false;
    let effectiveThinking = channelConfig.tools?.thinking ?? false;
    const model = meta.model ?? process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

    let accumulatedThinking = "";

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        console.log(`[AGENT] Iteration ${i + 1} — ${messages.length} messages, model=${model}`);

        const tools = buildToolDefinitions(channelConfig, execAllowed, userId);
        let response;
        try {
            response = await ollamaChat({ model, messages, tools, thinkingEnabled: effectiveThinking, client, signal });
        } catch (err) {
            if (err.code === "ERR_CANCELED") {
                messages.push({ role: "system", content: "Generation stopped: User interrupt." });
                console.log("[AGENT] Generation aborted by kill signal.");
                typing.stop();
                return { reply: "⛔ Generation stopped.", thinking: accumulatedThinking, memoriesInjected: false };
            }

            if (err.code === "OLLAMA_TIMEOUT") {
                messages.push({ role: "system", content: "Generation stopped: Timed out." });
                console.log("[AGENT] Generation timed out.");
                typing.stop();
                return { reply: `❌ ${err.message}`, thinking: "", memoriesInjected: false };
            }

            if (err.code === "THINKING_UNSUPPORTED") {
                effectiveThinking = false;
                channelConfig.tools.thinking = false;
                disableThinkingFn?.();
                console.warn(`[AGENT] Thinking unsupported for ${model} — auto-disabled.`);
                await replyFn(`⚠️ This model doesn't support thinking — automatically disabled for this channel.`);
                try {
                    response = await ollamaChat({ model, messages, tools, thinkingEnabled: false, client, signal });
                } catch (e2) {
                    if (e2.code === "ERR_CANCELED") {
                        messages.push({ role: "system", content: "Generation stopped: User interrupt." });
                        typing.stop();
                        return { reply: "⛔ Generation stopped.", thinking: accumulatedThinking, memoriesInjected: false };
                    }
                    console.error(`[AGENT] Error after thinking retry: ${e2.message}`);
                    typing.stop();
                    return { reply: `❌ ${e2.message}`, thinking: "", memoriesInjected: false };
                }
            }

            else if (err.code === "OLLAMA_500") {
                const imgEntry = [...messages.entries()].reverse().find(([, m]) => m.role === "user" && m.images?.length);
                if (imgEntry) {
                    const [imgIdx, imgMsg] = imgEntry;
                    console.warn("[AGENT] Ollama 500 with images — retrying without images.");
                    messages[imgIdx] = { ...imgMsg, content: imgMsg.content + "\n(Attached image not supported.)" };
                    delete messages[imgIdx].images;
                    try {
                        response = await ollamaChat({ model, messages, tools, thinkingEnabled: effectiveThinking, client, signal });
                    } catch (e2) {
                        if (e2.code === "ERR_CANCELED") {
                            messages.push({ role: "system", content: "Generation stopped: User interrupt." });
                            typing.stop();
                            return { reply: "⛔ Generation stopped.", thinking: accumulatedThinking, memoriesInjected: false };
                        }
                        console.error(`[AGENT] Error after image strip retry: ${e2.message}`);
                        typing.stop();
                        return { reply: `❌ ${e2.message}`, thinking: "", memoriesInjected: false };
                    }
                } else {
                    console.error(`[AGENT] Ollama 500 (no images to strip): ${err.message}`);
                    typing.stop();
                    return { reply: `❌ ${err.message}`, thinking: "", memoriesInjected: false };
                }
            }

            else {
                console.error(`[AGENT] Ollama error: ${err.message}`);
                typing.stop();
                return { reply: `❌ ${err.message}`, thinking: "", memoriesInjected: false };
            }
        }

        const { content, tool_calls, nativeThinking } = response;

        if (nativeThinking) {
            accumulatedThinking += (accumulatedThinking ? "\n\n---\n\n" : "") + nativeThinking;
        }

        const assistantMsg = { role: "assistant", content: content ?? "" };
        if (nativeThinking) assistantMsg.thinking = nativeThinking;
        messages.push(assistantMsg);

        if (!tool_calls || tool_calls.length === 0) {
            const reply = content?.trim();
            if (!reply) {
                console.warn("[AGENT] Empty response — nudging.");
                messages.push({ role: "user", content: "[System: Your last response was empty. Please provide a complete reply to the user.]" });
                continue;
            }
            console.log("[AGENT] No tool_calls — ending loop.");
            typing.stop();
            return { reply, thinking: accumulatedThinking, memoriesInjected: false };
        }

        if (content?.trim()) await replyFn(content.trim());

        for (const call of tool_calls) {
            const name = call.function?.name;
            const args = call.function?.arguments ?? {};
            console.log(`[AGENT] Tool call: ${name}`, args);

            const tool = TOOLS[name];
            if (!tool) {
                console.warn(`[AGENT] Unknown tool: ${name}`);
                messages.push({ role: "tool", content: `Unknown tool "${name}".` });
                continue;
            }

            let toolResult;

            if (name === "exec") {
                if (!execAllowed) {
                    toolResult = "Exec is disabled — command was not run.";
                } else {
                    const { result, isDenied } = await tool.exec(args, { replyFn, typing, messages, meta, client, signal });
                    if (isDenied) execAllowed = false;
                    toolResult = isDenied
                    ? `Denied: ${result}. Do not retry this command or suggest alternatives.`
                    : result;
                }
            } else {
                toolResult = await tool.exec(args, null, userId);
            }

            messages.push({ role: "tool", content: toolResult });
        }
    }

    console.warn("[AGENT] Reached maximum iterations.");
    typing.stop();
    return { reply: "Agent stopped after reaching the maximum number of iterations.", thinking: accumulatedThinking, memoriesInjected: false };
}

// ── Trigger entry point ───────────────────────────────────────────────────────
async function handleTrigger(content, replyFn, typing, channelConfig, contextKey, username, sourceMeta = {}, images = [], client, userId, signal = null) {
    console.log(`[TRIGGER] ${username}: "${content.slice(0, 80)}"`);
    const messages = getContext(contextKey, channelConfig);
    syncSystemPrompt(contextKey, channelConfig);

    const memoryBlock = userId ? memory.buildMemoryBlock(userId) : "";
    if (memoryBlock) {
        messages[0] = { role: "system", content: messages[0].content + memoryBlock };
        console.log(`[MEMORY] Injected ${memory.getMemories(userId).length} memories for user ${userId}`);
    }

    const userMsg = images.length > 0
    ? { role: "user", content: `[${username}]: ${content}`, images }
    : { role: "user", content: `[${username}]: ${content}` };
    messages.push(userMsg);

    // Build a callback that persists thinking=false to the right config scope.
    const guildId = sourceMeta?.guildId ?? null;
    const disableThinkingFn = () => {
        if (contextKey.startsWith("channel:")) {
            setGuildValue(guildId, contextKey.slice(8), "tools", "thinking", false);
        } else if (contextKey.startsWith("dm:")) {
            setDmValue(contextKey.slice(3), false, null, "tools", "thinking", false);
        } else if (contextKey.startsWith("gdm:")) {
            setDmValue(null, true, contextKey.slice(4), "tools", "thinking", false);
        } else {
            // guild: global scope — no channelId available here, in-memory only
            console.log("[AGENT] Thinking disabled in-memory only (guild-scope context).");
        }
    };

    const result = await runAgent(messages, replyFn, typing, channelConfig, sourceMeta, client, userId, signal, disableThinkingFn);

    // Suppress 🧠 button in guild/group contexts when memories were injected.
    const isDm = contextKey.startsWith("dm:");
    if (memoryBlock && !isDm) result.memoriesInjected = true;
    return result;
}

module.exports = { handleTrigger, splitMessage };
