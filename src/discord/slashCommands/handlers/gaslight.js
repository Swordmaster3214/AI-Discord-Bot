const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { resolveConfig, getContextKey }     = require("../../../state/config");
const { getContext }                       = require("../../../state/contexts");
const { canGaslight }                      = require("../../../state/permissions");

const builder = new SlashCommandBuilder()
.setName("gaslight")
.setDescription("Inject a fake assistant message into the AI context")
.addStringOption(o => o.setName("content").setDescription("The message to inject as if the bot said it").setRequired(true));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;

    const channelConfig = resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId);

    if (!canGaslight(interaction, channelConfig)) {
        return interaction.reply({ content: "You don't have permission to use `/gaslight` here.", flags: MessageFlags.Ephemeral });
    }

    const content    = interaction.options.getString("content");
    const contextKey = getContextKey(guildId, channelId, userId, isGroupDM, channelConfig.settings);
    const messages   = getContext(contextKey, channelConfig);

    messages.push({ role: "assistant", content });
    console.log(`[GASLIGHT] ${interaction.user.username} injected into ${contextKey}: "${content.slice(0, 80)}"`);

    await interaction.reply({ content: `✅ Injected into context \`${contextKey}\`.`, flags: MessageFlags.Ephemeral });
}

module.exports = { name: "gaslight", builder, handle };
