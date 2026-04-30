const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getChannelConfig, getContextKey, resolveModel, config } = require("../../../state/config");
const { isChannelAllowed }     = require("../../../state/permissions");
const { readTextAttachments, readImageAttachments } = require("../../../tools/attachments");
const { enqueue, splitMessage } = require("../../../core/queue");
const { REASONING_BUTTON_ID, storeThinking } = require("../../../tools/chainSender");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

const builder = new SlashCommandBuilder()
.setName("agent")
.setDescription("Run the AI agent")
.addStringOption(o => o.setName("prompt").setDescription("Your request").setRequired(true))
.addAttachmentOption(o => o.setName("file").setDescription("Optional file or image to include"));

async function handle(interaction, ctx, client) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;

    if (!isChannelAllowed(guildId, channelId, userId, isGroupDM, parentChannelId)) {
        return interaction.reply({ content: "The bot is not configured to respond in this channel.", flags: MessageFlags.Ephemeral });
    }
    const channelConfig = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
    if (channelConfig.mode === "none") {
        return interaction.reply({ content: "The bot is not configured to respond in this channel.", flags: MessageFlags.Ephemeral });
    }

    const prompt     = interaction.options.getString("prompt");
    const attachment = interaction.options.getAttachment("file");
    await interaction.deferReply();

    let attachmentText = "", attachmentImages = [];
    if (attachment) {
        const col        = new Map([[attachment.id, attachment]]);
        attachmentText   = await readTextAttachments(col);
        attachmentImages = await readImageAttachments(col);
    }
    const content = attachmentText ? `${prompt}\n\n${attachmentText}` : prompt;

    const contextKey    = getContextKey(guildId, channelId, userId, isGroupDM);
    const resolvedModel = resolveModel(guildId, contextKey, DEFAULT_MODEL);
    const sourceMeta    = guildId
    ? { source: `${interaction.guild?.name ?? guildId} / <#${channelId}>`, guildId }
    : { source: `DM with ${interaction.user.username}` };

    let midStepSent = false;
    await enqueue({
        content, images: attachmentImages, channelConfig, contextKey,
        userId, username: interaction.user.username,
        sourceMeta: { ...sourceMeta, model: resolvedModel, username: interaction.user.username },
        client,
        notifyFn:   msg => interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }),
                  replyFn:    async msg => { midStepSent = true; return interaction.followUp(msg); },
                  getChannel: async () => interaction.channel ?? await interaction.user.createDM(),
                  sendResult: async ({ reply, thinking, memoriesInjected }) => {
                      const chunks        = splitMessage(reply);
                      const showReasoning = thinking && !memoriesInjected;
                      const components    = showReasoning ? [new ActionRowBuilder().addComponents(
                          new ButtonBuilder().setCustomId(REASONING_BUTTON_ID).setLabel("🧠").setStyle(ButtonStyle.Secondary)
                      )] : [];
                      let sent;
                      try {
                          sent = await (midStepSent
                          ? interaction.followUp({ content: chunks[0], components })
                          : interaction.editReply({ content: chunks[0], components }));
                      } catch {
                          sent = await interaction.followUp({ content: chunks[0], components }).catch(() => null);
                      }
                      if (sent && thinking && !memoriesInjected) storeThinking(sent.id, thinking);
                      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
                  },
    });
}

module.exports = { name: "agent", builder, handle };
