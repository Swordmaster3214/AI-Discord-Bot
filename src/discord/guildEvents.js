function register(client) {
    client.on("guildCreate", async (guild) => {
        console.log(`[GUILD] Joined: ${guild.name} (${guild.id})`);
        try {
            const owner = await client.users.fetch(process.env.OWNER_ID);
            await owner.send(
                `📥 **Joined a new guild**\n` +
                `**Name:** ${guild.name}\n` +
                `**ID:** \`${guild.id}\`\n` +
                `**Members:** ${guild.memberCount}\n\n` +
                `The bot is **silent by default**. ` +
                `Use \`/config mode\` in any channel there to enable it.`
            );
        } catch (err) {
            console.error(`[GUILD] Could not DM owner: ${err.message}`);
        }
    });
}

module.exports = { register };
