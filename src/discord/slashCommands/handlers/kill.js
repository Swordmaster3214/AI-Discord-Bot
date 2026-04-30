const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { getContextKey }        = require("../../../state/config");
const { isOwner, hasManageGuild } = require("../../../state/permissions");
const { activeGenerations }    = require("../../../core/queue");

const builder = new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Stop an in-progress AI generation in this channel")
    .addStringOption(o => o
        .setName("context")
        .setDescription("Context key to kill — owner only, see !active in owner DMs")
        .setRequired(false));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM } = ctx;
    const targetKey = interaction.options.getString("context");

    if (targetKey) {
        if (!isOwner(userId)) {
            return interaction.reply({ content: "Only the bot owner can kill by context key.", flags: MessageFlags.Ephemeral });
        }
        const gen = activeGenerations.get(targetKey);
        if (!gen) return interaction.reply({ content: `No active generation for \`${targetKey}\`.`, flags: MessageFlags.Ephemeral });
        gen.controller.abort();
        const elapsed = ((Date.now() - gen.startedAt) / 1000).toFixed(1);
        return interaction.reply({ content: `⛔ Killed \`${targetKey}\` (${gen.username}, ${elapsed}s).` });
    }

    const contextKey = getContextKey(guildId, channelId, userId, isGroupDM);
    const gen = activeGenerations.get(contextKey);
    if (!gen) return interaction.reply({ content: "No generation is currently running here.", flags: MessageFlags.Ephemeral });

    const isAdmin      = isOwner(userId) || hasManageGuild(interaction);
    const isOwnerOfGen = gen.userId === userId;
    if (!isAdmin && !isOwnerOfGen) {
        return interaction.reply({ content: "You can only stop your own generation. Server admins and the bot owner can stop any.", flags: MessageFlags.Ephemeral });
    }

    gen.controller.abort();
    const elapsed = ((Date.now() - gen.startedAt) / 1000).toFixed(1);
    return interaction.reply({
        content: `⛔ Stopped ${isOwnerOfGen ? "your" : `${gen.username}'s`} generation (${elapsed}s).`,
    });
}

module.exports = { name: "kill", builder, handle };
