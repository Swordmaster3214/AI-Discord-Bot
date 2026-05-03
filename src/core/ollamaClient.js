const axios = require("axios");
const { config } = require("../state/config");

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// Sends a chat request to Ollama using native tool calling.
// Throws typed errors for callers to handle:
//   THINKING_UNSUPPORTED — model rejected think:true (400)
//   OLLAMA_500           — server-side error (500), caller may retry without images
//   OLLAMA_TIMEOUT       — request timed out (ECONNABORTED)
//   ERR_CANCELED         — aborted via signal, propagated immediately
async function ollamaChat({ model, messages, tools = [], thinkingEnabled = false, client, signal = null }) {
    const attemptRequest = async (useThinking, useTools) => {
        const body = {
            model,
            messages,
            stream: false,
            think: useThinking,
        };
        if (useTools.length > 0) body.tools = useTools;

        const res = await axios.post(`${OLLAMA_URL}/api/chat`, body, {
            timeout: config.ollamaTimeout,
            signal,
        });

        const msg = res.data.message;
        const nativeThinking = msg.thinking?.trim() ?? "";
        if (nativeThinking) {
            console.log(`[THINKING:NATIVE] ${nativeThinking.slice(0, 120)}`);
        }
        return { content: msg.content ?? "", tool_calls: msg.tool_calls ?? [], nativeThinking };
    };

    try {
        return await attemptRequest(thinkingEnabled, tools);
    } catch (err) {
        // Propagate cancellations immediately — don't retry or wrap them.
        if (err.code === "ERR_CANCELED") throw err;

        if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
            throw new Error("Ollama is not running. Start it with `ollama serve` and try again.");
        }
        if (err.code === "ECONNABORTED") {
            const e = new Error("Ollama timed out. The model may be taking too long to respond.");
            e.code = "OLLAMA_TIMEOUT";
            throw e;
        }

        // 400 with think:true — surface to agentLoop to auto-disable and notify user.
        if (err.response?.status === 400 && thinkingEnabled) {
            console.warn(`[OLLAMA] Model ${model} rejected think:true — surfacing THINKING_UNSUPPORTED.`);
            const e = new Error(`Model ${model} does not support thinking.`);
            e.code = "THINKING_UNSUPPORTED";
            e.model = model;
            throw e;
        }

        // 500 — surface to agentLoop (may retry without images).
        if (err.response?.status === 500) {
            const e = new Error(`Ollama returned 500: ${err.response?.data?.error ?? err.message}`);
            e.code = "OLLAMA_500";
            throw e;
        }

        throw new Error(`Ollama error: ${err.message}`);
    }
}

module.exports = { ollamaChat };
