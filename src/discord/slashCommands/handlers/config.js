const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const {
    config, getGuildConfig, getChannelConfig, setChannelConfig,
    getContextKey, saveConfig,
} = require("../../../state/config");
const { contexts, clearContext, clearGuildContexts } = require("../../../state/contexts");
const { isOwner, hasManageGuild } = require("../../../state/permissions");
const { resolveConfigTarget }     = require("../utils");

// Maps toggle subcommand name → { configKey, label, ownerOnlyInDms }
const TOGGLE_SUBCOMMANDS = {
    exec:     { key: "execEnabled",     label: "Exec",           ownerOnlyInDms: true  },
    browsing: { key: "browsingEnabled", label: "Web search",     ownerOnlyInDms: true  },
    thinking: { key: "thinkingEnabled", label: "Thinking",       ownerOnlyInDms: false },
    file:     { key: "fileEnabled",     label: "File access",    ownerOnlyInDms: true  },
    runcode:  { key: "runCodeEnabled",  label: "Code execution", ownerOnlyInDms: true  },
    fetch:    { key: "fetchEnabled",    label: "Page fetch",     ownerOnlyInDms: true  },
};

const builder = new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure bot")
    .addSubcommand(c => c
        .setName("mode")
        .setDescription("Set trigger mode for a channel or DM")
        .addStringOption(o => o.setName("value").setDescription("Trigger mode").setRequired(true)
            .addChoices(
                { name: "slash",   value: "slash"   },
                { name: "mention", value: "mention" },
                { name: "auto",    value: "auto"    },
                { name: "none",    value: "none"    }
            ))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("exec")
        .setDescription("Enable or disable exec (shell commands) — DMs: owner only")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("browsing")
        .setDescription("Enable or disable web search — DMs: owner only")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("thinking")
        .setDescription("Enable or disable native chain-of-thought thinking for the model")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("file")
        .setDescription("Enable or disable sandboxed file access — DMs: owner only")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("runcode")
        .setDescription("Enable or disable code execution — DMs: owner only")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("fetch")
        .setDescription("Enable or disable page fetching — DMs: owner only")
        .addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to configure"))
        .addUserOption(o => o.setName("user").setDescription("Configure another user's DMs (owner only)")))
    .addSubcommand(c => c
        .setName("timeout")
        .setDescription("Set Ollama request timeout in seconds (owner only, 0 = no timeout)")
        .addIntegerOption(o => o.setName("value").setDescription("Seconds").setRequired(true).setMinValue(0)))
    .addSubcommand(c => c
        .setName("gaslight")
        .setDescription("Set who can use /gaslight (ManageServer or owner)")
        .addStringOption(o => o.setName("value").setDescription("Permission level").setRequired(true)
            .addChoices({ name: "everyone", value: "everyone" }, { name: "manager", value: "manager" })))
    .addSubcommandGroup(g => g
        .setName("model")
        .setDescription("Configure model selection")
        .addSubcommand(c => c
            .setName("set")
            .setDescription("Set the Ollama model for this server or DM")
            .addStringOption(o => o.setName("value").setDescription("Model name").setRequired(true)))
        .addSubcommand(c => c
            .setName("permission")
            .setDescription("Set who can change the model (ManageServer or owner only)")
            .addStringOption(o => o.setName("value").setDescription("Permission level").setRequired(true)
                .addChoices({ name: "everyone", value: "everyone" }, { name: "manager", value: "manager" }))))
    .addSubcommandGroup(g => g
        .setName("context")
        .setDescription("Configure context behaviour")
        .addSubcommand(c => c
            .setName("scope")
            .setDescription("Set context scope (ManageServer or owner)")
            .addStringOption(o => o.setName("value").setDescription("Scope").setRequired(true)
                .addChoices(
                    { name: "local (per-channel)", value: "local"  },
                    { name: "global (per-guild)",  value: "global" }
                )))
        .addSubcommand(c => c
            .setName("clear")
            .setDescription("Set who can use /clearcontext (ManageServer or owner)")
            .addStringOption(o => o.setName("value").setDescription("Permission").setRequired(true)
                .addChoices({ name: "everyone", value: "everyone" }, { name: "manager", value: "manager" }))
            .addChannelOption(o => o.setName("channel").setDescription("Set for a specific channel only"))))
    .addSubcommand(c => c
        .setName("reset")
        .setDescription("Reset config to defaults")
        .addStringOption(o => o.setName("scope").setDescription("What to reset").setRequired(true)
            .addChoices(
                { name: "channel (ManageServer or owner)", value: "channel" },
                { name: "guild   (ManageServer or owner)", value: "guild"   },
                { name: "dm — your own DM config",         value: "dm"      },
                { name: "global  (owner only)",            value: "global"  }
            ))
        .addChannelOption(o => o.setName("channel").setDescription("Channel to reset"))
        .addUserOption(o => o.setName("user").setDescription("Reset another user's DM (owner only)")));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM } = ctx;
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    // ── model group ───────────────────────────────────────────────────────────
    if (group === "model") {
        if (sub === "set") {
            const value = interaction.options.getString("value");
            if (guildId) {
                const guild = getGuildConfig(guildId);
                if ((guild.modelPermission ?? "manager") === "manager" && !isOwner(userId) && !hasManageGuild(interaction)) {
                    return interaction.reply({ content: "You need the Manage Server permission to change the model.", flags: MessageFlags.Ephemeral });
                }
                guild.model = value;
                saveConfig(config);
                return interaction.reply({ content: `✅ Model for this server set to \`${value}\`.` });
            }
            setChannelConfig(null, channelId, "model", value, userId, isGroupDM);
            return interaction.reply({ content: `✅ Model for this DM set to \`${value}\`.`, flags: MessageFlags.Ephemeral });
        }
        if (sub === "permission") {
            if (!guildId) return interaction.reply({ content: "Model permission only applies in servers.", flags: MessageFlags.Ephemeral });
            if (!isOwner(userId) && !hasManageGuild(interaction)) {
                return interaction.reply({ content: "You need the Manage Server permission to change model permission.", flags: MessageFlags.Ephemeral });
            }
            const guild = getGuildConfig(guildId);
            guild.modelPermission = interaction.options.getString("value");
            saveConfig(config);
            return interaction.reply({ content: `✅ Model change permission set to \`${guild.modelPermission}\`.` });
        }
    }

    // ── context group ─────────────────────────────────────────────────────────
    if (group === "context") {
        if (sub === "scope") {
            if (!guildId) return interaction.reply({ content: "Context scope only applies in servers.", flags: MessageFlags.Ephemeral });
            if (!isOwner(userId) && !hasManageGuild(interaction)) {
                return interaction.reply({ content: "You need the Manage Server permission to change context scope.", flags: MessageFlags.Ephemeral });
            }
            const value    = interaction.options.getString("value");
            const guild    = getGuildConfig(guildId);
            const changed  = (guild.contextScope ?? "local") !== value;
            guild.contextScope = value;
            saveConfig(config);
            if (changed) clearGuildContexts(guildId);
            return interaction.reply({ content: `✅ Context scope set to **${value}**.${changed ? " All guild contexts cleared." : ""}` });
        }
        if (sub === "clear") {
            if (!guildId) return interaction.reply({ content: "Clear permissions only apply in servers.", flags: MessageFlags.Ephemeral });
            if (!isOwner(userId) && !hasManageGuild(interaction)) {
                return interaction.reply({ content: "You need the Manage Server permission to configure clear permissions.", flags: MessageFlags.Ephemeral });
            }
            const value         = interaction.options.getString("value");
            const targetChannel = interaction.options.getChannel("channel");
            const guild         = getGuildConfig(guildId);
            if (targetChannel) {
                if (!guild.channels[targetChannel.id]) guild.channels[targetChannel.id] = {};
                guild.channels[targetChannel.id].clearPermission = value;
                saveConfig(config);
                return interaction.reply({ content: `✅ Clear permission for <#${targetChannel.id}> set to **${value}**.` });
            }
            guild.clearPermission = value;
            saveConfig(config);
            return interaction.reply({ content: `✅ Default clear permission set to **${value}**.` });
        }
    }

    // ── timeout ───────────────────────────────────────────────────────────────
    if (sub === "timeout") {
        if (!isOwner(userId)) return interaction.reply({ content: "Only the bot owner can change the timeout.", flags: MessageFlags.Ephemeral });
        config.ollamaTimeout = interaction.options.getInteger("value") * 1000;
        saveConfig(config);
        const display = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
        return interaction.reply({ content: `✅ Timeout set to ${display}.` });
    }

    // ── gaslight permission ───────────────────────────────────────────────────
    if (sub === "gaslight") {
        if (!guildId) return interaction.reply({ content: "Gaslight permission only applies in servers.", flags: MessageFlags.Ephemeral });
        if (!isOwner(userId) && !hasManageGuild(interaction)) {
            return interaction.reply({ content: "You need the Manage Server permission to configure gaslight permission.", flags: MessageFlags.Ephemeral });
        }
        const guild = getGuildConfig(guildId);
        guild.gaslightPermission = interaction.options.getString("value");
        saveConfig(config);
        return interaction.reply({ content: `✅ Gaslight permission set to \`${guild.gaslightPermission}\`.` });
    }

    // ── toggle subcommands (mode + all boolean tool flags) ────────────────────
    if (sub === "mode" || sub in TOGGLE_SUBCOMMANDS) {
        if (guildId && !isOwner(userId) && !hasManageGuild(interaction)) {
            return interaction.reply({ content: "You need the Manage Server permission to configure the bot.", flags: MessageFlags.Ephemeral });
        }
        const { targetUser, targetChannelId, targetDmUserId, targetMention } = resolveConfigTarget(interaction, ctx);
        if (targetUser && !isOwner(userId)) {
            return interaction.reply({ content: "Only the bot owner can configure another user's DMs.", flags: MessageFlags.Ephemeral });
        }
        if (sub === "mode") {
            const value = interaction.options.getString("value");
            if (guildId) setChannelConfig(guildId, targetChannelId, "mode", value);
            else         setChannelConfig(null, channelId, "mode", value, targetDmUserId, isGroupDM);
            return interaction.reply({ content: `✅ Mode for ${targetMention} set to \`${value}\`.` });
        }
        const { key, label, ownerOnlyInDms } = TOGGLE_SUBCOMMANDS[sub];
        if (ownerOnlyInDms && !guildId && !isOwner(userId)) {
            return interaction.reply({ content: `Only the bot owner can enable ${label} in DMs.`, flags: MessageFlags.Ephemeral });
        }
        const value = interaction.options.getBoolean("value");
        if (guildId) setChannelConfig(guildId, targetChannelId, key, value);
        else         setChannelConfig(null, channelId, key, value, targetDmUserId, isGroupDM);
        return interaction.reply({ content: `✅ ${label} for ${targetMention} ${value ? "enabled" : "disabled"}.` });
    }

    // ── reset ─────────────────────────────────────────────────────────────────
    if (sub === "reset") {
        const scope = interaction.options.getString("scope");
        if (scope === "global") {
            if (!isOwner(userId)) return interaction.reply({ content: "Only the bot owner can reset global config.", flags: MessageFlags.Ephemeral });
            config.ollamaTimeout = 90000;
            saveConfig(config);
            contexts.clear();
            return interaction.reply({ content: "✅ Global config reset. All contexts cleared." });
        }
        if (scope === "guild") {
            if (!guildId) return interaction.reply({ content: "Guild reset only applies in servers.", flags: MessageFlags.Ephemeral });
            if (!isOwner(userId) && !hasManageGuild(interaction)) {
                return interaction.reply({ content: "You need the Manage Server permission to reset guild config.", flags: MessageFlags.Ephemeral });
            }
            clearGuildContexts(guildId);
            config.guilds[guildId] = { contextScope: "local", clearPermission: "everyone", modelPermission: "manager", gaslightPermission: "manager", channels: {} };
            saveConfig(config);
            return interaction.reply({ content: "✅ Guild config reset to defaults. All guild contexts cleared." });
        }
        if (scope === "channel") {
            if (!guildId) return interaction.reply({ content: "Channel reset only applies in servers.", flags: MessageFlags.Ephemeral });
            if (!isOwner(userId) && !hasManageGuild(interaction)) {
                return interaction.reply({ content: "You need the Manage Server permission to reset a channel's config.", flags: MessageFlags.Ephemeral });
            }
            const targetChannel   = interaction.options.getChannel("channel");
            const targetChannelId = targetChannel?.id ?? channelId;
            const guild           = getGuildConfig(guildId);
            delete guild.channels[targetChannelId];
            saveConfig(config);
            contexts.delete(`channel:${targetChannelId}`);
            return interaction.reply({ content: `✅ Config for ${targetChannel ? `<#${targetChannelId}>` : "this channel"} reset. Channel context cleared.` });
        }
        if (scope === "dm") {
            const targetUser = interaction.options.getUser("user");
            if (targetUser && !isOwner(userId)) {
                return interaction.reply({ content: "Only the bot owner can reset another user's DM config.", flags: MessageFlags.Ephemeral });
            }
            const uid = targetUser?.id ?? userId;
            delete config.dms[uid];
            saveConfig(config);
            contexts.delete(`dm:${uid}`);
            return interaction.reply({ content: `✅ Reset ${targetUser ? `${targetUser.username}'s DM config` : "your DM config"}. DM context cleared.` });
        }
    }
}

module.exports = { name: "config", builder, handle };
