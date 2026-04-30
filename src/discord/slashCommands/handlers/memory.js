const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const memory           = require("../../../state/memory");
const { splitMessage } = require("../../../core/queue");

const builder = new SlashCommandBuilder()
    .setName("memory")
    .setDescription("Manage your personal long-term memories")
    .addSubcommand(c => c.setName("enable").setDescription("Opt in to persistent memory — bot will remember facts about you across sessions"))
    .addSubcommand(c => c.setName("disable").setDescription("Pause memory injection — your memories are preserved"))
    .addSubcommand(c => c.setName("list").setDescription("View your stored memories (only visible to you)"))
    .addSubcommand(c => c.setName("clear").setDescription("Delete all your stored memories (cannot be undone)"))
    .addSubcommand(c => c
        .setName("add")
        .setDescription("Manually store a new memory")
        .addStringOption(o => o.setName("fact").setDescription("The fact to remember").setRequired(true)))
    .addSubcommand(c => c
        .setName("delete")
        .setDescription("Delete a specific memory by ID (see /memory list for IDs)")
        .addIntegerOption(o => o.setName("id").setDescription("Memory ID").setRequired(true).setMinValue(1)))
    .addSubcommand(c => c
        .setName("edit")
        .setDescription("Replace the text of an existing memory")
        .addIntegerOption(o => o.setName("id").setDescription("Memory ID").setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName("fact").setDescription("New fact text").setRequired(true)));

async function handle(interaction, ctx) {
    if (!memory.ENABLED) {
        return interaction.reply({
            content: "❌ Memory is not enabled on this bot (no `MEMORY_KEY` configured).",
            flags: MessageFlags.Ephemeral,
        });
    }

    const { userId } = ctx;
    const sub = interaction.options.getSubcommand();

    if (sub === "enable") {
        memory.setUserEnabled(userId, true);
        console.log(`[MEMORY] User ${userId} opted in.`);
        return interaction.reply({
            content:
                "✅ **Memory enabled.** The bot will now remember facts about you across sessions.\n\n" +
                "**Privacy note:** Memories are encrypted at rest and only injected when you speak. " +
                "When active, the 🧠 reasoning button is hidden to keep your memories private. " +
                "Use `/memory list` to see what's stored, or `/memory disable` to pause memory injection.",
            flags: MessageFlags.Ephemeral,
        });
    }

    if (sub === "disable") {
        memory.setUserEnabled(userId, false);
        console.log(`[MEMORY] User ${userId} opted out — memories preserved.`);
        return interaction.reply({
            content: "✅ **Memory disabled.** Your stored memories are preserved but will no longer be injected. Use `/memory enable` to resume, or `/memory clear` to delete everything.",
            flags: MessageFlags.Ephemeral,
        });
    }

    if (sub === "list") {
        const mems    = memory.getMemories(userId);
        const enabled = memory.isUserEnabled(userId);
        if (mems.length === 0) {
            return interaction.reply({
                content: enabled
                    ? "No memories stored yet. Chat with the bot and it will remember things over time."
                    : "Memory is not enabled. Use `/memory enable` to opt in.",
                flags: MessageFlags.Ephemeral,
            });
        }
        const lines  = mems.map(m => `\`#${m.id}\` [${new Date(m.created_at).toISOString().slice(0, 10)}] ${m.fact}`).join("\n");
        const chunks = splitMessage(`**Your memories (${mems.length}/50):**\n${lines}`, 1900);
        await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
        for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
        return;
    }

    if (sub === "clear") {
        const count = memory.clearMemories(userId);
        console.log(`[MEMORY] User ${userId} cleared own memories — deleted ${count}.`);
        return interaction.reply({
            content: `✅ Deleted ${count} stored ${count === 1 ? "memory" : "memories"}. Memory is now disabled.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    if (sub === "add") {
        if (!memory.isUserEnabled(userId)) {
            return interaction.reply({ content: "Memory is not enabled. Use `/memory enable` first.", flags: MessageFlags.Ephemeral });
        }
        const fact   = interaction.options.getString("fact").trim().slice(0, 200);
        const result = memory.addMemory(userId, fact);
        const evictNote = result.evictedId ? ` (oldest memory #${result.evictedId} evicted — limit 50)` : "";
        console.log(`[MEMORY] User ${userId} manually added memory #${result.id}`);
        return interaction.reply({ content: `✅ Memory #${result.id} stored.${evictNote}`, flags: MessageFlags.Ephemeral });
    }

    if (sub === "delete") {
        const id      = interaction.options.getInteger("id");
        const deleted = memory.deleteMemory(userId, id);
        if (!deleted) {
            return interaction.reply({ content: `No memory #${id} found. Use \`/memory list\` to see your IDs.`, flags: MessageFlags.Ephemeral });
        }
        console.log(`[MEMORY] User ${userId} manually deleted memory #${id}`);
        return interaction.reply({ content: `✅ Memory #${id} deleted.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === "edit") {
        const id      = interaction.options.getInteger("id");
        const newFact = interaction.options.getString("fact").trim().slice(0, 200);
        const updated = memory.updateMemory(userId, id, newFact);
        if (!updated) {
            return interaction.reply({ content: `No memory #${id} found. Use \`/memory list\` to see your IDs.`, flags: MessageFlags.Ephemeral });
        }
        console.log(`[MEMORY] User ${userId} manually edited memory #${id}`);
        return interaction.reply({ content: `✅ Memory #${id} updated.`, flags: MessageFlags.Ephemeral });
    }
}

module.exports = { name: "memory", builder, handle };
