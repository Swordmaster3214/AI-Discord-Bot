const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { getChannelConfig, getContextKey } = require("../../../state/config");
const { getContext }       = require("../../../state/contexts");
const { canGaslight }      = require("../../../state/permissions");

const builder = new SlashCommandBuilder()
    .setName("gaslight")
    .setDescription("Inject a fake assistant message into the AI context")
    .addStringOption(o => o.setName("content").setDescription("The message to inject as if the bot said it").setRequired(true))
    .addBooleanOption(o => o.setName("ephemeral").setDescription("Hide the slash command response (default: true)"))
    .addBooleanOption(o => o.setName("announce").setDescription("Send the injected text as a visible bot message (default: false)"));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;

    if (!canGaslight(interaction, guildId)) {
        return interaction.reply({ content: "You don't have permission to use `/gaslight` here.", flags: MessageFlags.Ephemeral });
    }

    const content      = interaction.options.getString("content");
    const useEphemeral = interaction.options.getBoolean("ephemeral") ?? true;
    const doAnnounce   = interaction.options.getBoolean("announce") ?? false;

    const channelConfig = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
    const contextKey    = getContextKey(guildId, channelId, userId, isGroupDM);
    const messages      = getContext(contextKey, channelConfig);

    messages.push({ role: "assistant", content });
    console.log(`[GASLIGHT] ${interaction.user.username} injected into ${contextKey}: "${content.slice(0, 80)}"`);

    await interaction.reply({
        content: `✅ Injected into context \`${contextKey}\`.`,
        flags: useEphemeral ? MessageFlags.Ephemeral : undefined,
    });

    if (doAnnounce) {
        const channel = interaction.channel ?? await interaction.user.createDM();
        await channel.send(content);
    }
}

module.exports = { name: "gaslight", builder, handle };
