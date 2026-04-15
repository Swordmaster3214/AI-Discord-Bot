const axios = require("axios");
const { config }                   = require("../state/config");
const { unsupportedThinkingModels } = require("../state/contexts");

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// Sends a chat request to Ollama using native tool calling.
// Falls back on 400 only for unsupported thinking — tools are always sent.
async function ollamaChat({ model, messages, tools = [], thinkingEnabled = false, client }) {
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
        });

        const msg = res.data.message;
        const nativeThinking = msg.thinking?.trim() ?? "";
        if (nativeThinking) {
            console.log(`[THINKING:NATIVE] ${nativeThinking.slice(0, 120)}`);
        }
        return { content: msg.content ?? "", tool_calls: msg.tool_calls ?? [], nativeThinking };
    };

    // First attempt — full feature set
    try {
        return await attemptRequest(thinkingEnabled, tools);
    } catch (err) {
        if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
            throw new Error("Ollama is not running. Start it with `ollama serve` and try again.");
        }
        if (err.code === "ECONNABORTED") {
            throw new Error("Ollama timed out. The model may be taking too long to respond.");
        }

        // 400 with think:true — model does not support native thinking, retry without it
        if (err.response?.status === 400 && thinkingEnabled && !unsupportedThinkingModels.has(model)) {
            console.warn(`[OLLAMA] Model ${model} rejected think:true — retrying without it.`);
            unsupportedThinkingModels.add(model);
            if (client) {
                try {
                    const owner = await client.users.fetch(process.env.OWNER_ID);
                    await owner.send(
                        `⚠️ **Thinking not supported**\n` +
                        `Model \`${model}\` returned a 400 when thinking was enabled.\n` +
                        `The request was retried without thinking and succeeded.\n` +
                        `Use \`/config thinking false\` or switch to a thinking-capable model.`
                    );
                } catch {}
            }
            return await attemptRequest(false, tools);
        }

        throw new Error(`Ollama error: ${err.message}`);
    }
}

module.exports = { ollamaChat };
