const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { config, getGuildConfig, getChannelConfig } = require("../../../state/config");
const { runAsync } = require("../utils");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";

const builder = new SlashCommandBuilder()
    .setName("help")
    .setDescription("Help and info")
    .addSubcommand(c => c.setName("info").setDescription("Show bot status and command reference"))
    .addSubcommand(c => c.setName("models").setDescription("List available Ollama models"));

async function handle(interaction, ctx) {
    const { guildId, channelId, userId, isGroupDM, parentChannelId } = ctx;
    const sub = interaction.options.getSubcommand(false) ?? "info";

    if (sub === "models") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await runAsync("ollama", ["list"], 10_000); // async — non-blocking
        const lines  = (result.stdout ?? "").trim().split("\n");
        const models = lines.slice(1).filter(l => l.trim());
        if (models.length === 0) return interaction.editReply("No models found.");
        const formatted = models.map(l => {
            const cols = l.trim().split(/\s{2,}/);
            return `\`${cols[0] ?? l}\`${cols[2] ? ` — ${cols[2]}` : ""}`;
        }).join("\n");
        return interaction.editReply(`**Available models (${models.length}):**\n${formatted}`);
    }

    // sub === "info"
    const channelConfig       = getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
    const guildConf           = guildId ? getGuildConfig(guildId) : null;
    const modelDisplay        = guildId
        ? (guildConf.model ?? DEFAULT_MODEL)
        : isGroupDM
        ? (config.groupDms[channelId]?.model ?? DEFAULT_MODEL)
        : (config.dms[userId]?.model ?? DEFAULT_MODEL);
    const timeoutDisplay      = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
    const clearPermDisplay    = guildId
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
        "/kill [context] → Stop an in-progress generation",
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

module.exports = { name: "help", builder, handle };
