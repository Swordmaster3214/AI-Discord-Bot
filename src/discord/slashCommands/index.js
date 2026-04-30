const fs   = require("fs");
const path = require("path");
const { REST, Routes, MessageFlags } = require("discord.js");
const { getInteractionContext } = require("./utils");
const { REASONING_BUTTON_ID, getThinking } = require("../../tools/chainSender");
const { splitMessage } = require("../../core/queue");

// Auto-load every handler in ./handlers/.
// Each module must export: { name, builder, handle }
// Adding a new command = drop a new file in handlers/ — nothing else to change.
const handlers = new Map();
const commandBodies = [];

for (const file of fs.readdirSync(path.join(__dirname, "handlers")).filter(f => f.endsWith(".js"))) {
    const mod = require(`./handlers/${file}`);
    handlers.set(mod.name, mod.handle);
    commandBodies.push(mod.builder.toJSON());
    console.log(`[COMMANDS] Loaded: /${mod.name}`);
}

// ── Registration ──────────────────────────────────────────────────────────────
async function register(client) {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandBodies });
    console.log(`[COMMANDS] Registered ${handlers.size} slash commands.`);
}

// ── Router ────────────────────────────────────────────────────────────────────
function handleInteraction(client) {
    client.on("interactionCreate", async (interaction) => {

        // Reasoning button — not a slash command, handled here centrally.
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

        const handler = handlers.get(interaction.commandName);
        if (!handler) return;

        const ctx = getInteractionContext(interaction);
        return handler(interaction, ctx, client);
    });
}

module.exports = { register, handleInteraction };
