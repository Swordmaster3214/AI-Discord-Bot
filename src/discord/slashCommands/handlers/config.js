const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const {
    config, saveConfig,
    DEFAULTS, TOOL_KEYS, POLICY_KEYS,
    resolveConfig, getContextKey,
    setGuildValue, setDmValue,
    resetGuild, resetChannel, resetDm,
} = require("../../../state/config");
const { clearGuildContexts, contexts } = require("../../../state/contexts");
const { isOwner, satisfiesRole, canConfigure } = require("../../../state/permissions");

// ── Slash command definition ──────────────────────────────────────────────────

const builder = new SlashCommandBuilder()
.setName("config")
.setDescription("Configure bot settings, tools, and permissions")

// /config show
.addSubcommand(c => c
.setName("show")
.setDescription("Show the resolved config for this location (or a specific channel)")
.addChannelOption(o => o.setName("channel").setDescription("Channel to inspect")))

// /config mode
.addSubcommand(c => c
.setName("mode")
.setDescription("Set trigger mode")
.addStringOption(o => o
.setName("value").setDescription("Trigger mode").setRequired(true)
.addChoices(
    { name: "auto    — respond to every message", value: "auto"    },
    { name: "mention — respond when @mentioned",  value: "mention" },
    { name: "slash   — /agent command only",      value: "slash"   },
    { name: "none    — silent",                   value: "none"    },
))
.addChannelOption(o => o.setName("channel").setDescription("Apply to a specific channel (guild only)")))

// /config model
.addSubcommand(c => c
.setName("model")
.setDescription("Set the Ollama model for this location (omit value to reset to default)")
.addStringOption(o => o.setName("value").setDescription("Model name").setRequired(false))
.addChannelOption(o => o.setName("channel").setDescription("Apply to a specific channel (guild only)")))

// /config context
.addSubcommand(c => c
.setName("context")
.setDescription("Set conversation history scope (guild channels only)")
.addStringOption(o => o
.setName("value").setDescription("Scope").setRequired(true)
.addChoices(
    { name: "channel — each channel has its own history", value: "channel" },
    { name: "guild   — all channels share one history",   value: "guild"   },
)))

// /config tool
.addSubcommand(c => c
.setName("tool")
.setDescription("Enable or disable a tool")
.addStringOption(o => o
.setName("name").setDescription("Tool").setRequired(true)
.addChoices(
    { name: "search   — web search via SearXNG",          value: "search"   },
    { name: "exec     — shell commands (owner-approved)",  value: "exec"     },
            { name: "thinking — chain-of-thought reasoning",       value: "thinking" },
            { name: "file     — sandboxed file read/write",        value: "file"     },
            { name: "runCode  — Python / Node.js execution",       value: "runCode"  },
            { name: "fetch    — webpage fetching",                 value: "fetch"    },
))
.addBooleanOption(o => o.setName("value").setDescription("Enable or disable").setRequired(true))
.addChannelOption(o => o.setName("channel").setDescription("Apply to a specific channel (guild only)")))

// /config policy
.addSubcommand(c => c
.setName("policy")
.setDescription("Set who may perform an action (guild only)")
.addStringOption(o => o
.setName("action").setDescription("Action").setRequired(true)
.addChoices(
    { name: "configure    — use /config",       value: "configure"    },
    { name: "clearContext — use /clearcontext", value: "clearContext" },
    { name: "gaslight     — use /gaslight",     value: "gaslight"     },
    { name: "model        — change model",      value: "model"        },
))
.addStringOption(o => o
.setName("role").setDescription("Minimum role required").setRequired(true)
.addChoices(
    { name: "owner    — bot owner only",        value: "owner"    },
    { name: "admin    — ManageServer or owner", value: "admin"    },
    { name: "everyone — any user",              value: "everyone" },
))
.addChannelOption(o => o.setName("channel").setDescription("Apply to a specific channel (guild only)")))

// /config reset
.addSubcommand(c => c
.setName("reset")
.setDescription("Clear stored overrides, reverting to inherited defaults")
.addStringOption(o => o
.setName("scope").setDescription("What to reset").setRequired(true)
.addChoices(
    { name: "channel — this channel's overrides", value: "channel" },
    { name: "guild   — entire guild config",      value: "guild"   },
    { name: "dm      — your DM config",           value: "dm"      },
))
.addChannelOption(o => o.setName("channel").setDescription("Which channel to reset (defaults to current)")))

// /config timeout
.addSubcommand(c => c
.setName("timeout")
.setDescription("Set global Ollama request timeout in seconds (0 = none) — owner only")
.addIntegerOption(o => o
.setName("value").setDescription("Seconds").setRequired(true).setMinValue(0)));

// ── Handler ───────────────────────────────────────────────────────────────────

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;
    const sub = interaction.options.getSubcommand();

    // Resolve the config for the current location for policy checks.
    const resolved = resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId);

    // ── /config timeout — owner-only, no policy gate ──────────────────────────
    if (sub === "timeout") {
        if (!isOwner(userId)) {
            return interaction.reply({ content: "Only the bot owner can change the global timeout.", flags: MessageFlags.Ephemeral });
        }
        config.ollamaTimeout = interaction.options.getInteger("value") * 1000;
        saveConfig(config);
        const display = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
        return interaction.reply({ content: `✅ Timeout set to **${display}**.` });
    }

    // ── /config show — no permission required ─────────────────────────────────
    if (sub === "show") {
        const targetChannel = interaction.options.getChannel("channel");
        const showChannelId = targetChannel?.id ?? channelId;
        const r = resolveConfig(guildId, showChannelId, userId, isGroupDM, parentChannelId);
        const t = r.tools;
        const p = r.policy;
        const label = targetChannel ? `<#${showChannelId}>` : (guildId ? "this channel" : "this DM");

        return interaction.reply({
            content: [
                `**Config for ${label}** *(resolved — includes inherited values)*`,
                                 `**Settings**`,
                                 `  mode     \`${r.settings.mode}\``,
                                 `  model    \`${r.settings.model ?? "(default)"}\``,
                                 ...(guildId ? [`  context  \`${r.settings.context}\``] : []),
                                 `**Tools**`,
                                 ...TOOL_KEYS.map(k => `  ${k.padEnd(9)} ${t[k] ? "✅" : "❌"}`),
                                 `**Policy**`,
                                 ...POLICY_KEYS.map(k => `  ${k.padEnd(14)} \`${p[k]}\``),
            ].join("\n"),
                                 flags: MessageFlags.Ephemeral,
        });
    }

    // ── All remaining subcommands require configure permission ─────────────────
    if (!canConfigure(interaction, resolved)) {
        return interaction.reply({
            content: `You don't have permission to use \`/config\` here (policy: \`${resolved.policy.configure}\`).`,
                                 flags: MessageFlags.Ephemeral,
        });
    }

    // ── /config context — guild-only, writes at guild level ───────────────────
    if (sub === "context") {
        if (!guildId) {
            return interaction.reply({ content: "`/config context` only applies in servers.", flags: MessageFlags.Ephemeral });
        }
        const value   = interaction.options.getString("value");
        const current = config.guilds[guildId]?.settings?.context ?? DEFAULTS.settings.context;
        setGuildValue(guildId, null, "settings", "context", value);
        if (current !== value) clearGuildContexts(guildId);
        return interaction.reply({
            content: `✅ Context scope set to **${value}**.${current !== value ? " All guild contexts cleared." : ""}`,
        });
    }

    // ── Helper: resolve the write target from optional #channel option ─────────
    function resolveTarget() {
        if (!guildId) {
            return { isDm: true, targetChannelId: null, mention: isGroupDM ? "this group DM" : "your DMs" };
        }
        const ch   = interaction.options.getChannel("channel");
        const tcId = ch?.id ?? null;
        return {
            isDm: false,
            targetChannelId: tcId,
            mention: tcId ? `<#${tcId}>` : "this channel (guild default)",
        };
    }

    // ── /config mode ──────────────────────────────────────────────────────────
    if (sub === "mode") {
        const { isDm, targetChannelId, mention } = resolveTarget();
        const value = interaction.options.getString("value");
        if (isDm) setDmValue(userId, isGroupDM, channelId, "settings", "mode", value);
        else      setGuildValue(guildId, targetChannelId, "settings", "mode", value);
        return interaction.reply({ content: `✅ Mode for **${mention}** set to \`${value}\`.` });
    }

    // ── /config model ─────────────────────────────────────────────────────────
    if (sub === "model") {
        // Model changes respect the "model" policy key, which can be stricter than "configure".
        if (!satisfiesRole(interaction, resolved.policy.model)) {
            return interaction.reply({
                content: `Changing the model requires the \`${resolved.policy.model}\` role here.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        const { isDm, targetChannelId, mention } = resolveTarget();
        const value = interaction.options.getString("value") ?? null; // null = clear override
        if (isDm) setDmValue(userId, isGroupDM, channelId, "settings", "model", value);
        else      setGuildValue(guildId, targetChannelId, "settings", "model", value);
        const display = value ? `\`${value}\`` : "*(server default)*";
        return interaction.reply({ content: `✅ Model for **${mention}** set to ${display}.` });
    }

    // ── /config tool ──────────────────────────────────────────────────────────
    if (sub === "tool") {
        const toolName = interaction.options.getString("name");
        if (!TOOL_KEYS.includes(toolName)) {
            return interaction.reply({ content: `Unknown tool \`${toolName}\`.`, flags: MessageFlags.Ephemeral });
        }
        // Exec and other sensitive tools are owner-only in DMs.
        const ownerOnlyInDms = ["exec", "search", "file", "runCode", "fetch"];
        if (!guildId && ownerOnlyInDms.includes(toolName) && !isOwner(userId)) {
            return interaction.reply({
                content: `Only the bot owner can enable \`${toolName}\` in DMs.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        const { isDm, targetChannelId, mention } = resolveTarget();
        const value = interaction.options.getBoolean("value");
        if (isDm) setDmValue(userId, isGroupDM, channelId, "tools", toolName, value);
        else      setGuildValue(guildId, targetChannelId, "tools", toolName, value);
        return interaction.reply({
            content: `✅ Tool \`${toolName}\` **${value ? "enabled" : "disabled"}** for **${mention}**.`,
        });
    }

    // ── /config policy ────────────────────────────────────────────────────────
    if (sub === "policy") {
        if (!guildId) {
            return interaction.reply({ content: "`/config policy` only applies in servers.", flags: MessageFlags.Ephemeral });
        }
        const action = interaction.options.getString("action");
        const role   = interaction.options.getString("role");
        if (!POLICY_KEYS.includes(action)) {
            return interaction.reply({ content: `Unknown action \`${action}\`.`, flags: MessageFlags.Ephemeral });
        }
        const { targetChannelId, mention } = resolveTarget();
        setGuildValue(guildId, targetChannelId, "policy", action, role);
        return interaction.reply({
            content: `✅ Policy **${action}** → \`${role}\` for **${mention}**.`,
        });
    }

    // ── /config reset ─────────────────────────────────────────────────────────
    if (sub === "reset") {
        const scope = interaction.options.getString("scope");

        if (scope === "guild") {
            if (!guildId) return interaction.reply({ content: "Guild reset only applies in servers.", flags: MessageFlags.Ephemeral });
            clearGuildContexts(guildId);
            resetGuild(guildId);
            return interaction.reply({ content: "✅ Guild config reset to defaults. All guild contexts cleared." });
        }

        if (scope === "channel") {
            if (!guildId) return interaction.reply({ content: "Channel reset only applies in servers.", flags: MessageFlags.Ephemeral });
            const targetChannel   = interaction.options.getChannel("channel");
            const targetChannelId = targetChannel?.id ?? channelId;
            resetChannel(guildId, targetChannelId);
            contexts.delete(`channel:${targetChannelId}`);
            const mention = targetChannel ? `<#${targetChannelId}>` : "this channel";
            return interaction.reply({ content: `✅ Config for ${mention} reset (now inherits from guild). Context cleared.` });
        }

        if (scope === "dm") {
            resetDm(userId, isGroupDM, channelId);
            contexts.delete(`dm:${userId}`);
            return interaction.reply({ content: "✅ Your DM config reset to defaults. DM context cleared.", flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = { name: "config", builder, handle };
