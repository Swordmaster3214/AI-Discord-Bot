const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { config, getGuildConfig }           = require("./config");

function isOwner(userId) {
    return userId === process.env.OWNER_ID;
}

function hasManageGuild(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

// ── Thread detection ──────────────────────────────────────────────────────────
const THREAD_TYPES = new Set([
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
]);

function getParentChannelId(channel) {
    if (!channel) return null;
    return THREAD_TYPES.has(channel.type) ? (channel.parentId ?? null) : null;
}

// ── Channel access ────────────────────────────────────────────────────────────
// Returns true if the bot should respond in this channel.
// Guild channels: default-closed until at least one channel is configured.
// DMs and group DMs: always open unless mode is explicitly "none".
function isChannelAllowed(guildId, channelId, userId, isGroupDM, parentChannelId = null) {
    if (!guildId) {
        if (isGroupDM) {
            const c = config.groupDms[channelId];
            return !c || c.mode !== "none";
        }
        const c = config.dms[userId];
        return !c || c.mode !== "none";
    }
    const guild = getGuildConfig(guildId);
    const hasConfigured = Object.keys(guild.channels).length > 0;
    if (hasConfigured) {
        if (Object.prototype.hasOwnProperty.call(guild.channels, channelId)) return true;
        if (parentChannelId && Object.prototype.hasOwnProperty.call(guild.channels, parentChannelId)) return true;
        return false;
    }
    return false; // default-closed
}

// ── Context clear permission ──────────────────────────────────────────────────
function canClearContext(interaction, guildId, channelId) {
    if (isOwner(interaction.user.id)) return true;
    if (!guildId) return true;
    const guild = getGuildConfig(guildId);
    const channelConf = guild.channels[channelId];
    const effectivePerm = channelConf?.clearPermission ?? guild.clearPermission ?? "everyone";
    return effectivePerm === "everyone" || hasManageGuild(interaction);
}

// ── Gaslight permission ───────────────────────────────────────────────────────
function canGaslight(interaction, guildId) {
    if (isOwner(interaction.user.id)) return true;
    if (!guildId) return false; // DMs: owner only
    const guild = getGuildConfig(guildId);
    const effectivePerm = guild.gaslightPermission ?? "manager";
    return effectivePerm === "everyone" || hasManageGuild(interaction);
}

module.exports = {
    isOwner, hasManageGuild,
    THREAD_TYPES, getParentChannelId,
    isChannelAllowed, canClearContext, canGaslight,
};
