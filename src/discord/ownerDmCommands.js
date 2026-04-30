const { config }     = require("../state/config");
const { contexts }   = require("../state/contexts");
const { clearGuildContexts } = require("../state/contexts");
const { isOwner }    = require("../state/permissions");
const { splitMessage } = require("../core/queue");
const { activeGenerations } = require("../core/queue");
const { runAsync }   = require("./slashCommands/utils");
const memory         = require("../state/memory");

const PREFIX = "!";

// Strip ANSI escape codes and tidy whitespace from terminal output.
// Kept here rather than utils.js — only needed for raw terminal output
// in owner DM commands, not in slash command handlers.
function stripAnsi(str) {
    return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function handle(message, cmd, client) {
    const parts   = cmd.trim().split(/\s+/);
    const command = parts[0].toLowerCase();

    if (command === "help") {
        return message.reply(
            "**Owner DM commands**\n" +
            "`!guilds` — list all known guilds\n" +
            "`!contexts` — list all active in-memory contexts\n" +
            "`!dms` — list all users with a DM config entry\n" +
            "`!clear guild <guildId>` — clear all contexts for a guild\n" +
            "`!clear dm <userId>` — clear a specific user's DM context\n" +
            "`!clear all` — clear every context in memory\n" +
            "`!active` — list in-progress generations\n" +
            "`!kill <contextKey>` — abort a generation by context key\n" +
            "`!exec <command>` — run a shell command on the host machine\n" +
            "`!models` — list available Ollama models\n" +
            "`!model pull <name>` — pull a model\n" +
            "`!model rm <name>` — remove a model\n" +
            "`!memory stats` — show memory DB stats (counts only, no content)\n" +
            "`!memory clear <hash>` — delete all memories for a user hash"
        );
    }

    if (command === "guilds") {
        const ids = Object.keys(config.guilds);
        if (ids.length === 0) return message.reply("No guilds in config.");
        const lines = await Promise.all(ids.map(async gid => {
            const guildConf = config.guilds[gid];
            const channelCount = Object.keys(guildConf.channels ?? {}).length;
            const activeCtxCount = [...contexts.keys()].filter(k =>
            k === `guild:${gid}` ||
            Object.keys(guildConf.channels ?? {}).some(cid => k === `channel:${cid}`)
            ).length;
            let name = gid;
            try { const g = await client.guilds.fetch(gid); name = g.name; } catch {}
            return `**${name}** (\`${gid}\`)\n  Channels: ${channelCount} | Active contexts: ${activeCtxCount} | Scope: ${guildConf.contextScope ?? "local"}`;
        }));
        return message.reply(`**Known guilds (${ids.length}):**\n${lines.join("\n\n")}`);
    }

    if (command === "contexts") {
        if (contexts.size === 0) return message.reply("No active contexts in memory.");
        const lines = [...contexts.entries()].map(([k, msgs]) =>
        `\`${k}\` — ${msgs.length} messages (incl. system prompt)`
        );
        return message.reply(`**Active contexts (${contexts.size}):**\n${lines.join("\n")}`);
    }

    if (command === "dms") {
        const ids = Object.keys(config.dms);
        if (ids.length === 0) return message.reply("No DM config entries.");
        const lines = await Promise.all(ids.map(async uid => {
            const dm = config.dms[uid];
            let tag = uid;
            try { const u = await client.users.fetch(uid); tag = `${u.username} (${uid})`; } catch {}
            const hasCtx = contexts.has(`dm:${uid}`);
            return `**${tag}**\n  exec: ${dm.execEnabled} | browsing: ${dm.browsingEnabled} | mode: ${dm.mode} | context: ${hasCtx ? "active" : "none"}`;
        }));
        return message.reply(`**DM config entries (${ids.length}):**\n${lines.join("\n\n")}`);
    }

    if (command === "clear") {
        const scope = parts[1]?.toLowerCase();
        if (scope === "all") {
            const count = contexts.size;
            contexts.clear();
            console.log("[OWNER] Cleared all contexts.");
            return message.reply(`✅ Cleared all ${count} context(s) from memory.`);
        }
        if (scope === "guild") {
            const guildId = parts[2];
            if (!guildId) return message.reply("Usage: `!clear guild <guildId>`");
            if (!config.guilds[guildId]) return message.reply(`No guild config for \`${guildId}\`.`);
            clearGuildContexts(guildId);
            return message.reply(`✅ Cleared all contexts for guild \`${guildId}\`.`);
        }
        if (scope === "dm") {
            const uid = parts[2];
            if (!uid) return message.reply("Usage: `!clear dm <userId>`");
            const key = `dm:${uid}`;
            if (!contexts.has(key)) return message.reply(`No active DM context for \`${uid}\`.`);
            contexts.delete(key);
            console.log(`[OWNER] Cleared DM context for ${uid}.`);
            return message.reply(`✅ Cleared DM context for \`${uid}\`.`);
        }
        return message.reply("Usage: `!clear all` | `!clear guild <guildId>` | `!clear dm <userId>`");
    }

    if (command === "active") {
        if (activeGenerations.size === 0) return message.reply("No generations currently running.");
        const lines = [...activeGenerations.entries()].map(([key, g]) => {
            const elapsed = ((Date.now() - g.startedAt) / 1000).toFixed(1);
            return `\`${key}\` — ${g.username} — ${elapsed}s elapsed`;
        });
        return message.reply(`**Active generations (${activeGenerations.size}):**\n${lines.join("\n")}`);
    }

    if (command === "kill") {
        const key = parts[1];
        if (!key) return message.reply("Usage: `!kill <contextKey>`");
        const gen = activeGenerations.get(key);
        if (!gen) return message.reply(`No active generation for \`${key}\`.`);
        gen.controller.abort();
        const elapsed = ((Date.now() - gen.startedAt) / 1000).toFixed(1);
        console.log(`[OWNER] Killed generation for ${key} (${gen.username}, ${elapsed}s elapsed).`);
        return message.reply(`⛔ Killed \`${key}\` (${gen.username}, was running for ${elapsed}s).`);
    }

    if (command === "exec") {
        const shellCmd = parts.slice(1).join(" ");
        if (!shellCmd) return message.reply("Usage: `!exec <command>`");
        console.log(`[OWNER] !exec: ${shellCmd}`);
        try {
            const result = await runAsync("/bin/sh", ["-c", shellCmd], 30_000);
            const stdout = stripAnsi(result.stdout);
            const stderr = stripAnsi(result.stderr);
            const out = [];
            if (result.timedOut) out.push("⚠️ **Command timed out after 30 seconds.**");
            if (stdout) out.push(`**stdout:**\n\`\`\`\n${stdout}\n\`\`\``);
            if (stderr) out.push(`**stderr:**\n\`\`\`\n${stderr}\n\`\`\``);
            if (!stdout && !stderr) out.push("*(no output)*");
            if (result.status !== 0 && result.status !== null) out.push(`**exit code:** ${result.status}`);
            const chunks = splitMessage(out.join("\n"), 1900);
            await message.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
        } catch (err) {
            return message.reply(`❌ exec error: ${err.message}`);
        }
        return;
    }

    if (command === "models") {
        const result = await runAsync("ollama", ["list"], 10_000);
        const out = stripAnsi(result.stdout || result.stderr || "(no output)");
        return message.reply(`**Ollama models:**\n\`\`\`\n${out}\n\`\`\``);
    }

    if (command === "model") {
        const action    = parts[1]?.toLowerCase();
        const modelName = parts.slice(2).join(" ");

        if (action === "pull") {
            if (!modelName) return message.reply("Usage: `!model pull <name>`");
            console.log(`[OWNER] Pulling model: ${modelName}`);
            await message.reply(`⏳ Pulling \`${modelName}\`… this may take a while. Other users can still chat.`);
            const result = await runAsync("ollama", ["pull", modelName], 600_000);
            if (result.timedOut) {
                return message.channel.send(`⚠️ Pull timed out after 10 minutes for \`${modelName}\`.`);
            }
            const out = stripAnsi(result.stdout || result.stderr || "Done.").slice(-1500);
            return message.channel.send(`✅ Pull complete:\n\`\`\`\n${out}\n\`\`\``);
        }

        if (action === "rm") {
            if (!modelName) return message.reply("Usage: `!model rm <name>`");
            const result = await runAsync("ollama", ["rm", modelName], 30_000);
            const out = stripAnsi(result.stdout || result.stderr || "Done.");
            return message.reply(`✅\n\`\`\`\n${out}\n\`\`\``);
        }

        return message.reply("Usage: `!model pull <name>` | `!model rm <name>`");
    }

    if (command === "memory") {
        if (!memory.ENABLED) return message.reply("Memory is not enabled (no `MEMORY_KEY` configured).");
        const action = parts[1]?.toLowerCase();

        if (action === "stats") {
            const stats = memory.getStats();
            if (stats.total === 0) return message.reply("No memories stored.");
            const lines = stats.users.map(u =>
            `\`${u.user_hash.slice(0, 16)}…\` — ${u.cnt} ${u.cnt === 1 ? "memory" : "memories"}`
            ).join("\n");
            return message.reply(`**Memory stats — ${stats.total} total:**\n${lines}`);
        }

        if (action === "clear") {
            const hash = parts[2];
            if (!hash) return message.reply("Usage: `!memory clear <hash>`");
            const count = memory.clearByHash(hash);
            console.log(`[OWNER] Cleared ${count} memories for hash ${hash.slice(0, 16)}…`);
            return message.reply(count > 0
            ? `✅ Deleted ${count} ${count === 1 ? "memory" : "memories"} for hash \`${hash.slice(0, 16)}…\`.`
            : `No memories found for hash \`${hash}\`.`);
        }

        return message.reply("Usage: `!memory stats` | `!memory clear <hash>`");
    }

    return message.reply(`Unknown command \`!${command}\`. Type \`!help\` for a list.`);
}

module.exports = { PREFIX, handle, isOwnerDmCommand: (message) => isOwner(message.author.id) };
