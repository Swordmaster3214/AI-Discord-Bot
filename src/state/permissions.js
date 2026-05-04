const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { DEFAULTS } = require("./config");

// ── Role checks ───────────────────────────────────────────────────────────────

function isOwner(userId) {
    return userId === process.env.OWNER_ID;
}

function hasManageGuild(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

// Checks whether interaction.user satisfies a policy role string.
// "owner"    → only the bot owner
// "admin"    → ManageGuild permission or owner
// "everyone" → any user
function satisfiesRole(interaction, role) {
    switch (role ?? "admin") {
        case "owner":    return isOwner(interaction.user.id);
        case "everyone": return true;
        default:         return isOwner(interaction.user.id) || hasManageGuild(interaction);
    }
}

// ── Policy helpers ────────────────────────────────────────────────────────────
//
// All accept a fully-resolved config (from resolveConfig()) so they never need
// to touch the raw config store or derive policy themselves.
//
// action = one of POLICY_KEYS: "configure" | "clearContext" | "gaslight" | "model"
//
function canPerform(interaction, action, resolvedConfig) {
    const role = resolvedConfig?.policy?.[action] ?? DEFAULTS.policy[action];
    return satisfiesRole(interaction, role);
}

function canConfigure(interaction, resolvedConfig) {
    if (isOwner(interaction.user.id)) return true;
    return canPerform(interaction, "configure", resolvedConfig);
}

function canClearContext(interaction, resolvedConfig) {
    if (isOwner(interaction.user.id)) return true;
    return canPerform(interaction, "clearContext", resolvedConfig);
}

function canGaslight(interaction, resolvedConfig) {
    if (isOwner(interaction.user.id)) return true;
    if (!interaction.guildId) return false; // DMs: owner-only regardless of policy
    return canPerform(interaction, "gaslight", resolvedConfig);
}

function canChangeModel(interaction, resolvedConfig) {
    if (isOwner(interaction.user.id)) return true;
    return canPerform(interaction, "model", resolvedConfig);
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

module.exports = {
    isOwner,
    hasManageGuild,
    satisfiesRole,
    canPerform,
    canConfigure,
    canClearContext,
    canGaslight,
    canChangeModel,
    THREAD_TYPES,
    getParentChannelId,
};
