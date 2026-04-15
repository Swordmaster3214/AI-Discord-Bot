require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");

// Validate required env vars before doing anything else
for (const key of ["DISCORD_TOKEN", "OWNER_ID"]) {
    if (!process.env[key]) {
        console.error(`[ERROR] Missing ${key} in .env`);
        process.exit(1);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
});

// Surface any internal discord.js warnings/errors.
client.on("warn",  (info) => console.warn(`[DJS:WARN] ${info}`));
client.on("error", (err)  => console.error(`[DJS:ERROR] ${err.message}`));

// ── Raw DM workaround ─────────────────────────────────────────────────────────
// discord.js silently drops MESSAGE_CREATE for uncached DM channels because it
// cannot construct a DMChannel without recipient data from the cache.
// If the channel IS cached, discord.js emits messageCreate normally — we skip.
// If it is NOT cached, we fetch it (populating the cache) and re-emit manually.
client.on("raw", async (packet) => {
    if (packet.t !== "MESSAGE_CREATE") return;
    const d = packet.d;
    if (d.guild_id || d.channel_type !== 1) return;
    if (client.channels.cache.has(d.channel_id)) return;

    try {
        const channel = await client.channels.fetch(d.channel_id);
        const message = await channel.messages.fetch(d.id);
        client.emit("messageCreate", message);
    } catch (err) {
        console.error(`[RAW:DM] Failed to recover uncached DM: ${err.message}`);
    }
});

// ── Module registration ───────────────────────────────────────────────────────
const guildEvents     = require("./src/discord/guildEvents");
const messageTriggers = require("./src/discord/messageTriggers");
const slashCommands   = require("./src/discord/slashCommands");

client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await slashCommands.register(client);
});

guildEvents.register(client);
messageTriggers.register(client);
slashCommands.handleInteraction(client);

client.login(process.env.DISCORD_TOKEN);
