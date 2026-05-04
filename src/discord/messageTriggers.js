const { ChannelType }                              = require("discord.js");
const { resolveConfig, isChannelOpen, getContextKey } = require("../state/config");
const { isOwner, getParentChannelId }               = require("../state/permissions");
const { readTextAttachments, readImageAttachments } = require("../tools/attachments");
const { makeChainSender }                           = require("../tools/chainSender");
const { splitMessage, enqueue }                     = require("../core/queue");
const ownerDm                                       = require("./ownerDmCommands");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

function register(client) {
    client.on("messageCreate", async (message) => {
        if (message.author.bot) return;

        if (message.partial) {
            try { message = await message.fetch(); } catch { return; }
        }

        const guildId         = message.guild?.id ?? null;
        const channelId       = message.channel.id;
        const userId          = message.author.id;
        const isGroupDM       = !guildId && message.channel.type === ChannelType.GroupDM;
        const parentChannelId = getParentChannelId(message.channel);

        // ── Owner DM commands ─────────────────────────────────────────────────
        if (!guildId && !isGroupDM && isOwner(userId) &&
            message.content.startsWith(ownerDm.PREFIX)) {
            const cmd = message.content.slice(ownerDm.PREFIX.length);
        return ownerDm.handle(message, cmd, client);
            }

            if (!isChannelOpen(guildId, channelId, userId, isGroupDM, parentChannelId)) return;

            const channelConfig = resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
        if (channelConfig.settings.mode === "slash" || channelConfig.settings.mode === "none") return;

        const isMentioned = message.mentions.has(client.user) ||
        (message.reference?.messageId != null);
        if (channelConfig.settings.mode === "mention" && !isMentioned) return;

        const baseContent = message.content.replace(/<@!?\d+>/, "").trim();

        // ── Attachment reading ────────────────────────────────────────────────
        const attachmentText   = message.attachments.size > 0
        ? await readTextAttachments(message.attachments) : "";
        const attachmentImages = message.attachments.size > 0
        ? await readImageAttachments(message.attachments) : [];

        const content = attachmentText
        ? (baseContent ? `${baseContent}\n\n${attachmentText}` : attachmentText)
        : baseContent;
        if (!content && attachmentImages.length === 0) return;
        const finalContent = content || "(Image attached — describe or analyse as appropriate.)";

        const contextKey    = getContextKey(guildId, channelId, userId, isGroupDM, channelConfig.settings);
        const resolvedModel = channelConfig.settings.model ?? DEFAULT_MODEL;
        const sourceMeta    = guildId
        ? { source: parentChannelId
            ? `${message.guild?.name ?? guildId} / <#${parentChannelId}> / thread <#${channelId}>`
            : `${message.guild?.name ?? guildId} / <#${channelId}>`,
            guildId }
            : { source: `DM with ${message.author.username}` };

            const { chainSend, sendFinal } = makeChainSender(message);

            await enqueue({
                content:    finalContent,
                images:     attachmentImages,
                channelConfig,
                contextKey,
                userId,
                username:   message.author.username,
                sourceMeta: { ...sourceMeta, model: resolvedModel, username: message.author.username },
                client,
                notifyFn:   (msg) => message.reply(msg),
                          replyFn:    (msg) => chainSend(msg),
                          getChannel: async () => message.channel,
                          sendResult: async ({ reply, thinking, memoriesInjected }) => {
                              const chunks = splitMessage(reply);
                              await sendFinal(chunks[0], thinking, memoriesInjected);
                              for (let i = 1; i < chunks.length; i++) await chainSend(chunks[i]);
                          },
            });
    });
}

module.exports = { register };
