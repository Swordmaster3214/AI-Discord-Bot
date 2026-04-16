const { ollamaChat }    = require("./ollamaClient");
const { getSystemPrompt } = require("./systemPrompt");
const { getContext, syncSystemPrompt } = require("../state/contexts");
const execTool       = require("../tools/exec");
const searchTool     = require("../tools/search");
const memoryTools    = require("../tools/memoryTools");
const memory         = require("../state/memory");
const fileTool       = require("../tools/file");
const runCodeTool    = require("../tools/runCode");
const fetchTool      = require("../tools/fetch");

const MAX_ITERATIONS = 10;

// ── Tool registry ─────────────────────────────────────────────────────────────
// Add new tools here only. No other changes needed to support them.
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
    if (execAllowed && channelConfig.execEnabled)                 enabled.push("exec");
    if (channelConfig.browsingEnabled)                            enabled.push("search");
    if (channelConfig.fileEnabled)                                enabled.push("file");
    if (channelConfig.runCodeEnabled)                             enabled.push("run_code");
    if (channelConfig.fetchEnabled)                               enabled.push("fetch_page");
    if (memory.ENABLED && userId && memory.isUserEnabled(userId)) enabled.push("remember", "forget");
    return enabled.map(k => TOOLS[k].def);
}

// Splits a string into Discord-safe chunks (≤2000 chars).
// Priority: line boundary → word boundary → hard cut.
// Tracks open fenced code blocks and closes/reopens them across chunk boundaries
// so syntax highlighting and monospace rendering survive the split.
function splitMessage(text, size = 2000) {
    if (text.length <= size) return [text];

    const chunks  = [];
    const lines   = text.split("\n");
    let current   = "";
    let inBlock   = false;   // inside a fenced code block?
    let blockLang = "";      // opening fence language tag, e.g. "js"

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

        // Candidate too long — flush, then handle line.
        flush();

        if (line.length <= size) {
            current = inBlock ? "```" + blockLang + "\n" + line : line;
            continue;
        }

        // Line itself too long — split at word boundaries.
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
// Runs the conversation loop, dispatching tool_calls until the model produces
// a plain content response (no tool_calls).
// Returns { reply: string, thinking: string, memoriesInjected: bool }
async function runAgent(messages, replyFn, typing, channelConfig, meta = {}, client, userId) {
    let execAllowed = channelConfig.execEnabled;
    const thinkingEnabled = channelConfig.thinkingEnabled ?? false;
    const model = meta.model ?? process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

    // Accumulate thinking across all iterations — show the reasoning behind the
    // final answer, not just the last iteration (tool-call turns can think too).
    let accumulatedThinking = "";

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        console.log(`[AGENT] Iteration ${i + 1} — ${messages.length} messages, model=${model}`);

        const tools = buildToolDefinitions(channelConfig, execAllowed, userId);
        let response;
        try {
            response = await ollamaChat({ model, messages, tools, thinkingEnabled, client });
        } catch (err) {
            console.error(`[AGENT] Ollama error: ${err.message}`);
            typing.stop();
            return { reply: `❌ ${err.message}`, thinking: "", memoriesInjected: false };
        }

        const { content, tool_calls, nativeThinking } = response;

        if (nativeThinking) {
            accumulatedThinking += (accumulatedThinking ? "\n\n---\n\n" : "") + nativeThinking;
        }

        // Store assistant message in history.
        const assistantMsg = { role: "assistant", content: content ?? "" };
        if (nativeThinking) assistantMsg.thinking = nativeThinking;
        messages.push(assistantMsg);

        // ── Natural termination: no tool_calls means the model is done ────────
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

        // ── Tool dispatch ─────────────────────────────────────────────────────
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
                    const { result, isDenied } = await tool.exec(args, { replyFn, typing, messages, meta, client });
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
async function handleTrigger(content, replyFn, typing, channelConfig, contextKey, username, sourceMeta = {}, images = [], client, userId) {
    console.log(`[TRIGGER] ${username}: "${content.slice(0, 80)}"`);
    const messages = getContext(contextKey, channelConfig);
    syncSystemPrompt(contextKey, channelConfig);

    // Inject per-user memories into the system prompt for this turn only.
    // syncSystemPrompt already refreshed messages[0]; we append the memory block.
    // The base system prompt is restored next turn by syncSystemPrompt.
    const memoryBlock = userId ? memory.buildMemoryBlock(userId) : "";
    if (memoryBlock) {
        messages[0] = { role: "system", content: messages[0].content + memoryBlock };
        console.log(`[MEMORY] Injected ${memory.getMemories(userId).length} memories for user ${userId}`);
    }

    const userMsg = images.length > 0
    ? { role: "user", content: `[${username}]: ${content}`, images }
    : { role: "user", content: `[${username}]: ${content}` };
    messages.push(userMsg);

    const result = await runAgent(messages, replyFn, typing, channelConfig, sourceMeta, client, userId);

    // Flag memoriesInjected so callers can suppress the 🧠 button to protect privacy.
    if (memoryBlock) result.memoriesInjected = true;
    return result;
}

module.exports = { handleTrigger, splitMessage };
