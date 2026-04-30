const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { pendingApprovals } = require("../../../state/approvals");
const execToolMod          = require("../../../tools/exec");
const { isOwner }          = require("../../../state/permissions");

const builder = new SlashCommandBuilder()
    .setName("approve")
    .setDescription("Manage pending exec approval requests (bot owner only)")
    .addSubcommand(c => c.setName("list").setDescription("List all pending exec approval requests"))
    .addSubcommand(c => c
        .setName("decide")
        .setDescription("Accept or deny a pending exec request by ID")
        .addStringOption(o => o.setName("id").setDescription("Approval ID").setRequired(true))
        .addStringOption(o => o.setName("decision").setDescription("Accept or deny").setRequired(true)
            .addChoices({ name: "accept", value: "accept" }, { name: "deny", value: "deny" }))
        .addStringOption(o => o.setName("reason").setDescription("Optional reason for denial")));

async function handle(interaction, ctx) {
    if (!isOwner(ctx.userId)) {
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
        await execToolMod.approve(approvalId, decision, command, reason); // async — non-blocking
        return interaction.reply({
            content: decision === "accept"
                ? `✅ Request \`${approvalId}\` approved.`
                : `❌ Request \`${approvalId}\` denied${reason ? `: ${reason}` : "."}`,
        });
    }
}

module.exports = { name: "approve", builder, handle };
