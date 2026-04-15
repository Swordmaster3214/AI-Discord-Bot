const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// Static custom ID — the message the button belongs to is identified at click
// time via interaction.message.id, so the customId needs no dynamic content.
const REASONING_BUTTON_ID = "show_reasoning";

// ── Inline thinking store ─────────────────────────────────────────────────────
// Maps Discord message ID → thinking text, populated after each send.
// Entries expire after 1 hour and are pruned every 15 minutes.

const TTL_MS = 60 * 60 * 1000;
const thinkingStore = new Map();

function storeThinking(messageId, thinking) {
    thinkingStore.set(messageId, { thinking, expiresAt: Date.now() + TTL_MS });
}

function getThinking(messageId) {
    const entry = thinkingStore.get(messageId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { thinkingStore.delete(messageId); return null; }
    return entry.thinking;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, e] of thinkingStore) if (now > e.expiresAt) thinkingStore.delete(id);
}, 15 * 60 * 1000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────
const REASONING_ROW = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
    .setCustomId(REASONING_BUTTON_ID)
    .setLabel("🧠")
    .setStyle(ButtonStyle.Secondary)
);

// ── Chain sender ──────────────────────────────────────────────────────────────
function makeChainSender(message) {
    let lastBotMessageId = null;

    async function rawSend(text, components = []) {
        try {
            if (lastBotMessageId === null) {
                const sent = await message.reply({ content: text, components });
                lastBotMessageId = sent.id;
                return sent;
            }
            const fetched = await message.channel.messages.fetch({ limit: 1 });
            const isChained = fetched.first()?.id === lastBotMessageId;
            const sent = isChained
            ? await message.channel.send({ content: text, components })
            : await message.reply({ content: text, components });
            lastBotMessageId = sent.id;
            return sent;
        } catch (err) {
            console.error(`[CHAIN] Send error, falling back to reply: ${err.message}`);
            const sent = await message.reply({ content: text, components }).catch(() => null);
            if (sent) lastBotMessageId = sent.id;
            return sent;
        }
    }

    async function chainSend(text) {
        return rawSend(text);
    }

    // Sends with the reasoning button already attached (unless memories were injected,
    // in which case the button is suppressed to prevent memory leakage via reasoning).
    // Stores thinking keyed by the returned message ID. One network call, no edit.
    async function sendFinal(text, thinking = "", memoriesInjected = false) {
        const showReasoning = thinking && !memoriesInjected;
        const sent = await rawSend(text, showReasoning ? [REASONING_ROW] : []);
        if (sent && thinking && !memoriesInjected) storeThinking(sent.id, thinking);
        return sent;
    }

    return { chainSend, sendFinal };
}

module.exports = { makeChainSender, REASONING_BUTTON_ID, storeThinking, getThinking };
