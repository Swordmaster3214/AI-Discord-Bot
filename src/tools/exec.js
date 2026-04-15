const { execSync }             = require("child_process");
const { createPendingApproval, resolvePendingApproval } = require("../state/approvals");

// Native Ollama tool definition
const definition = {
    type: "function",
    function: {
        name: "exec",
        description:
        "Runs a shell command on the host machine. " +
        "Calling this tool automatically sends an approval request to the bot owner — do not wait for permission before calling it. " +
        "Never use for destructive or irreversible actions.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute.",
                },
            },
            required: ["command"],
        },
    },
};

// Executes the tool: requests approval, waits, runs or rejects.
// Returns { output, isDenied } for the agent loop to add as a tool message.
async function execute({ command }, { replyFn, typing, messages, meta, client }) {
    console.log(`[EXEC] Requested: ${command}`);
    typing.stop();

    const { id, promise } = await createPendingApproval(
        command,
        meta.source ?? "unknown",
        meta.username ?? "unknown",
        messages,
        client,
    );

    await replyFn(
        `⚠️ Command requested:\n\`${command}\`\n` +
        `Use \`/approve decide\` with ID \`${id}\` to accept or deny.`
    );

    console.log(`[EXEC] Waiting for approval (id=${id})...`);
    const result = await promise;
    console.log(`[EXEC] Approval resolved (id=${id}): ${result}`);

    typing.restart();
    return { result, isDenied: result.startsWith("Denied:") };
}

// Called by the /approve decide handler to resolve a pending request.
function approve(id, decision, command, reason) {
    let output;
    if (decision === "deny") {
        output = `Denied: ${reason}`;
    } else {
        try {
            output = execSync(command).toString();
            if (!output.trim()) output = "(no output)";
        } catch (e) {
            output = `Command failed: ${e.message}`;
        }
    }
    resolvePendingApproval(id, output);
    return output;
}

module.exports = { definition, execute, approve };
