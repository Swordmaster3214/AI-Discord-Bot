const { spawn }       = require("child_process");
const { ChannelType } = require("discord.js");
const { getParentChannelId } = require("../../state/permissions");

function getInteractionContext(interaction) {
    return {
        guildId:         interaction.guildId ?? null,
        channelId:       interaction.channelId,
        userId:          interaction.user.id,
        isGroupDM:       !interaction.guildId && interaction.channel?.type === ChannelType.GroupDM,
        parentChannelId: getParentChannelId(interaction.channel),
    };
}

function resolveConfigTarget(interaction, ctx) {
    const { guildId, channelId, isGroupDM } = ctx;
    const targetUser      = interaction.options.getUser("user");
    const targetChannel   = guildId ? interaction.options.getChannel("channel") : null;
    const targetChannelId = targetChannel?.id ?? channelId;
    const targetDmUserId  = targetUser?.id ?? ctx.userId;
    const targetMention   = guildId
    ? (targetChannel ? `<#${targetChannelId}>` : "this channel")
    : isGroupDM ? "this group DM"
    : (targetUser ? `${targetUser.username}'s DMs` : "your DMs");
    return { targetUser, targetChannel, targetChannelId, targetDmUserId, targetMention };
}

// Non-blocking async child process — does not stall the event loop.
function runAsync(cmd, args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d.toString(); });
        proc.stderr.on("data", d => { stderr += d.toString(); });
        proc.on("close", code => resolve({ stdout, stderr, status: code }));
        proc.on("error", reject);
        if (timeoutMs > 0) {
            setTimeout(() => {
                proc.kill();
                resolve({ stdout, stderr, status: null, timedOut: true });
            }, timeoutMs);
        }
    });
}

module.exports = { getInteractionContext, resolveConfigTarget, runAsync };
