const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { getChannelConfig, getContextKey, getGuildConfig } = require("../../../state/config");
const { clearContext, clearGuildContexts } = require("../../../state/contexts");
const { isOwner, hasManageGuild, canClearContext } = require("../../../state/permissions");

const builder = new SlashCommandBuilder()
    .setName("clearcontext")
    .setDescription("Clear the AI context for this location")
    .addBooleanOption(o => o
        .setName("all")
        .setDescription("Clear all guild contexts (ManageServer or owner only)")
        .setRequired(false));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;
    const clearAll = interaction.options.getBoolean("all") ?? false;

    if (clearAll) {
        if (!guildId) return interaction.reply({ content: "The `all` option only applies in servers.", flags: MessageFlags.Ephemeral });
        if (!isOwner(userId) && !hasManageGuild(interaction)) {
            return interaction.reply({ content: "You need the Manage Server permission to clear all guild contexts.", flags: MessageFlags.Ephemeral });
        }
        clearGuildContexts(guildId);
        return interaction.reply({ content: "✅ Cleared all contexts for this server." });
    }

    if (!canClearContext(interaction, guildId, channelId)) {
        return interaction.reply({ content: "You don't have permission to clear context here.", flags: MessageFlags.Ephemeral });
    }
    const channelConfig = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
    const contextKey    = getContextKey(guildId, channelId, userId, isGroupDM);
    clearContext(contextKey, channelConfig);
    const scopeLabel = (guildId && getGuildConfig(guildId).contextScope === "global") ? "guild-wide" : "this channel's";
    return interaction.reply({ content: `✅ Cleared ${scopeLabel} AI context.` });
}

module.exports = { name: "clearcontext", builder, handle };
