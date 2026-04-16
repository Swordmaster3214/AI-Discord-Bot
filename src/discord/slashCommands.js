const { REST, Routes, SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { spawnSync } = require("child_process");
const {
    config, getGuildConfig, getChannelConfig, setChannelConfig,
    getContextKey, resolveModel, saveConfig,
} = require("../state/config");
const {
    contexts, clearContext, clearGuildContexts, syncSystemPrompt, getContext,
} = require("../state/contexts");
const { pendingApprovals }     = require("../state/approvals");
const { execTool }             = require("../tools/exec");
const execToolMod              = require("../tools/exec");
const memory                   = require("../state/memory");
const {
    isOwner, hasManageGuild, canClearContext, canGaslight, getParentChannelId,
    isChannelAllowed,
} = require("../state/permissions");
const { enqueue, splitMessage } = require("../core/queue");
const { readTextAttachments, readImageAttachments } = require("../tools/attachments");
const { REASONING_BUTTON_ID, storeThinking, getThinking } = require("../tools/chainSender");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

// Maps subcommand name → { configKey, label, ownerOnlyInDms }
const TOGGLE_SUBCOMMANDS = {
    exec:     { key: "execEnabled",     label: "Exec",          ownerOnlyInDms: true  },
    browsing: { key: "browsingEnabled", label: "Web search",    ownerOnlyInDms: true  },
    thinking: { key: "thinkingEnabled", label: "Thinking",      ownerOnlyInDms: false },
    file:     { key: "fileEnabled",     label: "File access",   ownerOnlyInDms: true  },
    runcode:  { key: "runCodeEnabled",  label: "Code execution",ownerOnlyInDms: true  },
    fetch:    { key: "fetchEnabled",    label: "Page fetch",    ownerOnlyInDms: true  },
};

// ── Command builders ──────────────────────────────────────────────────────────
function buildCommands() {
    return [
        new SlashCommandBuilder()
        .setName("agent")
        .setDescription("Run the AI agent")
        .addStringOption(o => o.setName("prompt").setDescription("Your request").setRequired(true))
        .addAttachmentOption(o => o.setName("file").setDescription("Optional file or image to include")),

        new SlashCommandBuilder()
        .setName("approve")
        .setDescription("Manage pending exec approval requests (bot owner only)")
        .addSubcommand(c => c.setName("list").setDescription("List all pending exec approval requests"))
        .addSubcommand(c => c
        .setName("decide")
        .setDescription("Accept or deny a pending exec request by ID")
        .addStringOption(o => o.setName("id").setDescription("Approval ID").setRequired(true))
        .addStringOption(o => o.setName("decision").setDescription("Accept or deny").setRequired(true)
        .addChoices({ name: "accept", value: "accept" }, { name: "deny", value: "deny" }))
        .addStringOption(o => o.setName("reason").setDescription("Optional reason for denial"))),

        new SlashCommandBuilder()
        .setName("config")
        .setDescription("Configure bot")
        .addSubcommand(c => c
        .setName("mode")
        .setDescription("Set trigger mode for a channel or DM")
        .addStringOption(o => o.setName("value").setDescription("Trigger mode").setRequired(true)
        .addChoices(
            { name: "slash", value: "slash" }, { name: "mention", value: "mention" },
            { name: "auto",  value: "auto"  }, { name: "none",    value: "none"    }
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
            { name: "local (per-channel)", value: "local" },
                    { name: "global (per-guild)", value: "global" }
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
        .addUserOption(o => o.setName("user").setDescription("Reset another user's DM (owner only)"))),

        new SlashCommandBuilder()
        .setName("help")
        .setDescription("Help and info")
        .addSubcommand(c => c.setName("info").setDescription("Show bot status and command reference"))
        .addSubcommand(c => c.setName("models").setDescription("List available Ollama models")),

        new SlashCommandBuilder()
        .setName("clearcontext")
        .setDescription("Clear the AI context for this location")
        .addBooleanOption(o => o.setName("all")
        .setDescription("Clear all guild contexts (ManageServer or owner only)").setRequired(false)),

        new SlashCommandBuilder()
        .setName("gaslight")
        .setDescription("Inject a fake assistant message into the AI context")
        .addStringOption(o => o.setName("content").setDescription("The message to inject as if the bot said it").setRequired(true))
        .addBooleanOption(o => o.setName("ephemeral").setDescription("Hide the slash command response (default: true)"))
        .addBooleanOption(o => o.setName("announce").setDescription("Send the injected text as a visible bot message (default: false)")),

        new SlashCommandBuilder()
        .setName("memory")
        .setDescription("Manage your personal long-term memories")
        .addSubcommand(c => c.setName("enable").setDescription("Opt in to persistent memory — bot will remember facts about you across sessions"))
        .addSubcommand(c => c.setName("disable").setDescription("Pause memory injection — your memories are preserved"))
        .addSubcommand(c => c.setName("list").setDescription("View your stored memories (only visible to you)"))
        .addSubcommand(c => c.setName("clear").setDescription("Delete all your stored memories (cannot be undone)"))
        .addSubcommand(c => c
        .setName("add")
        .setDescription("Manually store a new memory")
        .addStringOption(o => o.setName("fact").setDescription("The fact to remember").setRequired(true)))
        .addSubcommand(c => c
        .setName("delete")
        .setDescription("Delete a specific memory by ID (see /memory list for IDs)")
        .addIntegerOption(o => o.setName("id").setDescription("Memory ID").setRequired(true).setMinValue(1)))
        .addSubcommand(c => c
        .setName("edit")
        .setDescription("Replace the text of an existing memory")
        .addIntegerOption(o => o.setName("id").setDescription("Memory ID").setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName("fact").setDescription("New fact text").setRequired(true))),

    ].map(c => c.toJSON());
}

// ── Registration ──────────────────────────────────────────────────────────────
async function register(client) {
    const commands = buildCommands();
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Slash commands registered.");
}

// ── Handler helpers ───────────────────────────────────────────────────────────
function getInteractionContext(interaction) {
    return {
        guildId:         interaction.guildId ?? null,
        channelId:       interaction.channelId,
        userId:          interaction.user.id,
        isGroupDM:       !interaction.guildId && interaction.channel?.type === 9,
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

// ── Main handler ──────────────────────────────────────────────────────────────
function handleInteraction(client) {
    client.on("interactionCreate", async (interaction) => {
        // ── Reasoning button ──────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === REASONING_BUTTON_ID) {
            const thinking = getThinking(interaction.message.id);
            if (!thinking) {
                return interaction.reply({
                    content: "⏳ The reasoning for this message is no longer available (expired after 1 hour).",
                                         flags: MessageFlags.Ephemeral,
                });
            }
            const chunks = splitMessage(`## 🧠 Reasoning\n${thinking}`);
            await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;
        const ctx = getInteractionContext(interaction);
        const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;

        // ── /agent ────────────────────────────────────────────────────────────
        if (commandName === "agent") {
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

            let attachmentText = "";
            let attachmentImages = [];
            if (attachment) {
                const fakeCollection = new Map([[attachment.id, attachment]]);
                attachmentText   = await readTextAttachments(fakeCollection);
                attachmentImages = await readImageAttachments(fakeCollection);
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
                notifyFn:   (msg) => interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }),
                          replyFn:    async (msg) => { midStepSent = true; return interaction.followUp(msg); },
                          getChannel: async () => interaction.channel ?? await interaction.user.createDM(),
                          sendResult: async ({ reply, thinking, memoriesInjected }) => {
                              const chunks = splitMessage(reply);
                              const showReasoning = thinking && !memoriesInjected;
                              const components = showReasoning ? [new ActionRowBuilder().addComponents(
                                  new ButtonBuilder()
                                  .setCustomId(REASONING_BUTTON_ID)
                                  .setLabel("🧠")
                                  .setStyle(ButtonStyle.Secondary)
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
            return;
        }

        // ── /approve ──────────────────────────────────────────────────────────
        if (commandName === "approve") {
            if (!isOwner(userId)) {
                return interaction.reply({ content: "Only the bot owner can use this command.", flags: MessageFlags.Ephemeral });
            }
            const sub = interaction.options.getSubcommand();

            if (sub === "list") {
                if (pendingApprovals.size === 0) {
                    return interaction.reply({ content: "No pending exec requests.", flags: MessageFlags.Ephemeral });
                }
                const list = [...pendingApprovals.entries()]
                .map(([id, { command, username, source }]) =>
                `**ID ${id}** — ${username} @ ${source}\n\`${command}\``)
                .join("\n\n");
                return interaction.reply({ content: `**Pending approvals:**\n${list}`, flags: MessageFlags.Ephemeral });
            }

            if (sub === "decide") {
                const approvalId = interaction.options.getString("id");
                const decision   = interaction.options.getString("decision");
                const reason     = interaction.options.getString("reason") || "";
                if (!pendingApprovals.has(approvalId)) {
                    return interaction.reply({ content: `No pending request with ID \`${approvalId}\`.`, flags: MessageFlags.Ephemeral });
                }
                const { command } = pendingApprovals.get(approvalId);
                execToolMod.approve(approvalId, decision, command, reason);
                return interaction.reply({
                    content: decision === "accept"
                    ? `✅ Request \`${approvalId}\` approved.`
                    : `❌ Request \`${approvalId}\` denied${reason ? `: ${reason}` : "."}`,
                });
            }
        }

        // ── /config ───────────────────────────────────────────────────────────
        if (commandName === "config") {
            const sub   = interaction.options.getSubcommand();
            const group = interaction.options.getSubcommandGroup(false);

            // model group
            if (group === "model") {
                if (sub === "set") {
                    const value = interaction.options.getString("value");
                    if (guildId) {
                        const guild = getGuildConfig(guildId);
                        const perm  = guild.modelPermission ?? "manager";
                        if (perm === "manager" && !isOwner(userId) && !hasManageGuild(interaction)) {
                            return interaction.reply({ content: "You need the Manage Server permission to change the model.", flags: MessageFlags.Ephemeral });
                        }
                        guild.model = value;
                        saveConfig(config);
                        return interaction.reply({ content: `✅ Model for this server set to \`${value}\`.` });
                    } else {
                        setChannelConfig(null, channelId, "model", value, userId, isGroupDM);
                        return interaction.reply({ content: `✅ Model for this DM set to \`${value}\`.`, flags: MessageFlags.Ephemeral });
                    }
                }
                if (sub === "permission") {
                    if (!guildId) return interaction.reply({ content: "Model permission only applies in servers.", flags: MessageFlags.Ephemeral });
                    if (!isOwner(userId) && !hasManageGuild(interaction)) {
                        return interaction.reply({ content: "You need the Manage Server permission to change model permission.", flags: MessageFlags.Ephemeral });
                    }
                    const value = interaction.options.getString("value");
                    const guild = getGuildConfig(guildId);
                    guild.modelPermission = value;
                    saveConfig(config);
                    return interaction.reply({ content: `✅ Model change permission set to \`${value}\`.` });
                }
            }

            // context group
            if (group === "context") {
                if (sub === "scope") {
                    if (!guildId) return interaction.reply({ content: "Context scope only applies in servers.", flags: MessageFlags.Ephemeral });
                    if (!isOwner(userId) && !hasManageGuild(interaction)) {
                        return interaction.reply({ content: "You need the Manage Server permission to change context scope.", flags: MessageFlags.Ephemeral });
                    }
                    const value    = interaction.options.getString("value");
                    const guild    = getGuildConfig(guildId);
                    const oldScope = guild.contextScope ?? "local";
                    guild.contextScope = value;
                    saveConfig(config);
                    if (oldScope !== value) {
                        clearGuildContexts(guildId);
                        return interaction.reply({ content: `✅ Context scope set to **${value}**. All guild contexts cleared.` });
                    }
                    return interaction.reply({ content: `✅ Context scope set to **${value}**.` });
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

            // timeout
            if (sub === "timeout") {
                if (!isOwner(userId)) return interaction.reply({ content: "Only the bot owner can change the timeout.", flags: MessageFlags.Ephemeral });
                config.ollamaTimeout = interaction.options.getInteger("value") * 1000;
                saveConfig(config);
                const display = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
                return interaction.reply({ content: `✅ Timeout set to ${display}.` });
            }

            // gaslight permission
            if (sub === "gaslight") {
                if (!guildId) return interaction.reply({ content: "Gaslight permission only applies in servers.", flags: MessageFlags.Ephemeral });
                if (!isOwner(userId) && !hasManageGuild(interaction)) {
                    return interaction.reply({ content: "You need the Manage Server permission to configure gaslight permission.", flags: MessageFlags.Ephemeral });
                }
                const value = interaction.options.getString("value");
                const guild = getGuildConfig(guildId);
                guild.gaslightPermission = value;
                saveConfig(config);
                return interaction.reply({ content: `✅ Gaslight permission set to \`${value}\`.` });
            }

            // ── Toggle subcommands (mode + all boolean tool flags) ─────────────
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

                // All remaining toggle subcommands share the same shape.
                const { key, label, ownerOnlyInDms } = TOGGLE_SUBCOMMANDS[sub];
                if (ownerOnlyInDms && !guildId && !isOwner(userId)) {
                    return interaction.reply({ content: `Only the bot owner can enable ${label} in DMs.`, flags: MessageFlags.Ephemeral });
                }
                const value = interaction.options.getBoolean("value");
                if (guildId) setChannelConfig(guildId, targetChannelId, key, value);
                else         setChannelConfig(null, channelId, key, value, targetDmUserId, isGroupDM);
                return interaction.reply({ content: `✅ ${label} for ${targetMention} ${value ? "enabled" : "disabled"}.` });
            }

            // reset
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
                    const mention = targetChannel ? `<#${targetChannelId}>` : "this channel";
                    return interaction.reply({ content: `✅ Config for ${mention} reset to defaults. Channel context cleared.` });
                }
                if (scope === "dm") {
                    const targetUser = interaction.options.getUser("user");
                    if (targetUser && !isOwner(userId)) {
                        return interaction.reply({ content: "Only the bot owner can reset another user's DM config.", flags: MessageFlags.Ephemeral });
                    }
                    const uid   = targetUser?.id ?? userId;
                    const label = targetUser ? `${targetUser.username}'s DM config` : "your DM config";
                    delete config.dms[uid];
                    saveConfig(config);
                    contexts.delete(`dm:${uid}`);
                    return interaction.reply({ content: `✅ Reset ${label} to defaults. DM context cleared.` });
                }
            }
        }

        // ── /help ─────────────────────────────────────────────────────────────
        if (commandName === "help") {
            const sub = interaction.options.getSubcommand(false) ?? "info";

            if (sub === "models") {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = spawnSync("ollama", ["list"], { encoding: "utf8", timeout: 10000 });
                const lines  = (result.stdout ?? "").trim().split("\n");
                const models = lines.slice(1).filter(l => l.trim());
                if (models.length === 0) return interaction.editReply("No models found.");
                const formatted = models.map(l => {
                    const cols = l.trim().split(/\s{2,}/);
                    const name = cols[0] ?? l;
                    const size = cols[2] ?? "";
                    return `\`${name}\`${size ? ` — ${size}` : ""}`;
                }).join("\n");
                return interaction.editReply(`**Available models (${models.length}):**\n${formatted}`);
            }

            // sub === "info"
            const channelConfig      = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
            const guildConf          = guildId ? getGuildConfig(guildId) : null;
            const modelDisplay       = guildId
            ? (guildConf.model ?? DEFAULT_MODEL)
            : isGroupDM
            ? (config.groupDms[channelId]?.model ?? DEFAULT_MODEL)
            : (config.dms[userId]?.model ?? DEFAULT_MODEL);
            const timeoutDisplay     = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
            const clearPermDisplay   = guildId
            ? (guildConf.channels[channelId]?.clearPermission ?? guildConf.clearPermission ?? "everyone")
            : "everyone";
            const gaslightPermDisplay = guildId ? (guildConf.gaslightPermission ?? "manager") : "owner only";
            const scopeDisplay        = guildConf ? (guildConf.contextScope ?? "local") : "local";

            const msg = [
                "🤖 **Help**", "",
                "**── This location ──**",
                `Mode: \`${channelConfig.mode}\` | Exec: \`${channelConfig.execEnabled}\` | Browsing: \`${channelConfig.browsingEnabled}\` | Thinking: \`${channelConfig.thinkingEnabled ?? false}\``,
                `File: \`${channelConfig.fileEnabled ?? false}\` | Run code: \`${channelConfig.runCodeEnabled ?? false}\` | Fetch: \`${channelConfig.fetchEnabled ?? false}\``,
                `Clear: \`${clearPermDisplay}\` | Gaslight: \`${gaslightPermDisplay}\` | Context scope: \`${scopeDisplay}\``,
                "",
                "**── Global ──**",
                `Model: \`${modelDisplay}\` | Timeout: \`${timeoutDisplay}\``,
                `Model change: \`${guildId ? (guildConf.modelPermission ?? "manager") : "n/a"}\``,
              "",
              "**── Commands ──**",
              "/help info → Show this message",
              "/help models → List available Ollama models",
              "/agent <prompt> [file] → Run the AI agent",
              "/approve list → List pending exec requests *(owner only)*",
              "/approve decide <id> <accept|deny> [reason] → Resolve a pending request *(owner only)*",
              "/clearcontext [all] → Clear AI context *(ManageServer or owner)*",
              "",
              "/config mode <value> [channel] [user]",
              "/config exec <value> [channel] [user] *(DMs: owner only)*",
              "/config browsing <value> [channel] [user] *(DMs: owner only)*",
              "/config thinking <value> [channel] [user]",
              "/config file <value> [channel] [user] *(DMs: owner only)*",
              "/config runcode <value> [channel] [user] *(DMs: owner only)*",
              "/config fetch <value> [channel] [user] *(DMs: owner only)*",
              "/config model set <n> → Set model *(server: permission-dependent; DM: anyone)*",
              "/config model permission <value> → Who can change model *(ManageServer or owner)*",
              "/config timeout <seconds> *(owner only)*",
              "/config context scope <value> *(ManageServer or owner)*",
              "/config context clear <value> [channel] *(ManageServer or owner)*",
              "/config gaslight <value> → Who can use /gaslight *(ManageServer or owner)*",
              "/config reset <scope> [channel] [user]",
              "",
              "/gaslight <content> [ephemeral] [announce] → Inject a fake assistant message *(permission-dependent)*",
              "",
              "/memory enable / disable → Opt in or pause memory",
              "/memory list → View stored memories",
              "/memory add <fact> → Manually store a memory",
              "/memory edit <id> <fact> → Replace a memory's text",
              "/memory delete <id> → Remove a specific memory",
              "/memory clear → Delete all memories",
            ].join("\n");

            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        // ── /clearcontext ─────────────────────────────────────────────────────
        if (commandName === "clearcontext") {
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
            const scopeLabel = (guildId && getGuildConfig(guildId).contextScope === "global")
            ? "guild-wide" : "this channel's";
            return interaction.reply({ content: `✅ Cleared ${scopeLabel} AI context.` });
        }

        // ── /gaslight ─────────────────────────────────────────────────────────
        if (commandName === "gaslight") {
            if (!canGaslight(interaction, guildId)) {
                return interaction.reply({ content: "You don't have permission to use `/gaslight` here.", flags: MessageFlags.Ephemeral });
            }

            const content      = interaction.options.getString("content");
            const useEphemeral = interaction.options.getBoolean("ephemeral") ?? true;
            const doAnnounce   = interaction.options.getBoolean("announce") ?? false;
            const replyFlags   = useEphemeral ? MessageFlags.Ephemeral : undefined;

            const channelConfig = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
            const contextKey    = getContextKey(guildId, channelId, userId, isGroupDM);
            const messages      = getContext(contextKey, channelConfig);

            messages.push({ role: "assistant", content });
            console.log(`[GASLIGHT] ${interaction.user.username} injected into ${contextKey}: "${content.slice(0, 80)}"`);

            await interaction.reply({ content: `✅ Injected into context \`${contextKey}\`.`, flags: replyFlags });

            if (doAnnounce) {
                const channel = interaction.channel ?? await interaction.user.createDM();
                await channel.send(content);
            }
            return;
        }

        // ── /memory ───────────────────────────────────────────────────────────
        if (commandName === "memory") {
            if (!memory.ENABLED) {
                return interaction.reply({
                    content: "❌ Memory is not enabled on this bot (no `MEMORY_KEY` configured).",
                                         flags: MessageFlags.Ephemeral,
                });
            }
            const sub = interaction.options.getSubcommand();

            if (sub === "enable") {
                memory.setUserEnabled(userId, true);
                console.log(`[MEMORY] User ${userId} opted in.`);
                return interaction.reply({
                    content:
                    "✅ **Memory enabled.** The bot will now remember facts about you across sessions.\n\n" +
                    "**Privacy note:** Memories are encrypted at rest and only injected when you speak. " +
                    "When active, the 🧠 reasoning button is hidden to keep your memories private. " +
                    "Use `/memory list` to see what's stored, or `/memory disable` to pause memory injection.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === "disable") {
                memory.setUserEnabled(userId, false);
                console.log(`[MEMORY] User ${userId} opted out — memories preserved.`);
                return interaction.reply({
                    content: `✅ **Memory disabled.** Your stored memories are preserved but will no longer be injected. Use \`/memory enable\` to resume, or \`/memory clear\` to delete everything.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === "list") {
                const mems    = memory.getMemories(userId);
                const enabled = memory.isUserEnabled(userId);
                if (mems.length === 0) {
                    return interaction.reply({
                        content: enabled
                        ? "No memories stored yet. Chat with the bot and it will remember things over time."
                        : "Memory is not enabled. Use `/memory enable` to opt in.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                const lines  = mems.map(m => {
                    const date = new Date(m.created_at).toISOString().slice(0, 10);
                    return `\`#${m.id}\` [${date}] ${m.fact}`;
                }).join("\n");
                const chunks = splitMessage(`**Your memories (${mems.length}/50):**\n${lines}`, 1900);
                await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
                }
                return;
            }

            if (sub === "clear") {
                const count = memory.clearMemories(userId);
                console.log(`[MEMORY] User ${userId} cleared own memories — deleted ${count}.`);
                return interaction.reply({
                    content: `✅ Deleted ${count} stored ${count === 1 ? "memory" : "memories"}. Memory is now disabled.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === "add") {
                if (!memory.isUserEnabled(userId)) {
                    return interaction.reply({
                        content: "Memory is not enabled. Use `/memory enable` first.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                const fact   = interaction.options.getString("fact").trim().slice(0, 200);
                const result = memory.addMemory(userId, fact);
                const evictNote = result.evictedId ? ` (oldest memory #${result.evictedId} evicted — limit 50)` : "";
                console.log(`[MEMORY] User ${userId} manually added memory #${result.id}`);
                return interaction.reply({
                    content: `✅ Memory #${result.id} stored.${evictNote}`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === "delete") {
                const id      = interaction.options.getInteger("id");
                const deleted = memory.deleteMemory(userId, id);
                if (!deleted) {
                    return interaction.reply({
                        content: `No memory #${id} found. Use \`/memory list\` to see your IDs.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
                console.log(`[MEMORY] User ${userId} manually deleted memory #${id}`);
                return interaction.reply({
                    content: `✅ Memory #${id} deleted.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === "edit") {
                const id      = interaction.options.getInteger("id");
                const newFact = interaction.options.getString("fact").trim().slice(0, 200);
                const updated = memory.updateMemory(userId, id, newFact);
                if (!updated) {
                    return interaction.reply({
                        content: `No memory #${id} found. Use \`/memory list\` to see your IDs.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
                console.log(`[MEMORY] User ${userId} manually edited memory #${id}`);
                return interaction.reply({
                    content: `✅ Memory #${id} updated.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    });
}

module.exports = { register, handleInteraction };
