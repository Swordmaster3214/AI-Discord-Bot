const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { config, resolveConfig }            = require("../../../state/config");
const { runAsync }                         = require("../utils");

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
        const result = await runAsync("ollama", ["list"], 10_000);
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
    const r = resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId);
    const t = r.tools;
    const p = r.policy;
    const timeoutDisplay = config.ollamaTimeout === 0 ? "none" : `${config.ollamaTimeout / 1000}s`;
    const modelDisplay   = r.settings.model ?? DEFAULT_MODEL;
    const scopeDisplay   = guildId ? r.settings.context : "n/a";

    const msg = [
        "🤖 **Help**", "",
        "**── This location ──**",
        `Mode: \`${r.settings.mode}\` | Exec: \`${t.exec}\` | Search: \`${t.search}\` | Thinking: \`${t.thinking}\``,
        `File: \`${t.file}\` | Run code: \`${t.runCode}\` | Fetch: \`${t.fetch}\``,
        `Configure: \`${p.configure}\` | Clear: \`${p.clearContext}\` | Gaslight: \`${p.gaslight}\` | Scope: \`${scopeDisplay}\``,
        "",
        "**── Global ──**",
        `Model: \`${modelDisplay}\` | Timeout: \`${timeoutDisplay}\``,
        `Model change: \`${guildId ? p.model : "n/a"}\``,
        "",
        "**── Commands ──**",
        "/help info → Show this message",
        "/help models → List available Ollama models",
        "/agent <prompt> [file] → Run the AI agent",
        "/kill [context] → Stop an in-progress generation",
        "/approve list → List pending exec requests *(owner only)*",
        "/approve decide <id> <accept|deny> [reason] → Resolve a pending request *(owner only)*",
        "/clearcontext [all] → Clear AI context",
        "",
        "/config show [#channel] → Show resolved config for a location",
        "/config mode <value> [#channel]",
        "/config model [value] [#channel]",
        "/config context <channel|guild> *(guild only)*",
        "/config tool <name> <true|false> [#channel]",
        "/config policy <action> <role> [#channel] *(guild only)*",
        "/config reset <channel|guild|dm>",
        "/config timeout <seconds> *(owner only)*",
        "",
        "/gaslight <content> [ephemeral] [announce] → Inject a fake assistant message",
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
