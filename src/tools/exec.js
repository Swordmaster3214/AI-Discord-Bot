const { spawn }                = require("child_process");
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

// Runs command via spawn so it can be killed mid-execution via signal.
// Returns the combined stdout+stderr output string.
function runCommand(command, signal) {
    return new Promise((resolve) => {
        const proc = spawn("/bin/sh", ["-c", command]);
        let output = "";

        proc.stdout.on("data", d => { output += d.toString(); });
        proc.stderr.on("data", d => { output += d.toString(); });

        const onAbort = () => {
            console.log(`[EXEC] Kill signal received — terminating child process.`);
            proc.kill("SIGTERM");
            // Give it a moment, then force kill.
            setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
        };

        if (signal) signal.addEventListener("abort", onAbort, { once: true });

        proc.on("close", (code) => {
            if (signal) signal.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
                resolve("Command killed: generation was stopped.");
            } else {
                resolve(output.trim() || `exit code ${code ?? "unknown"}`);
            }
        });

        proc.on("error", (err) => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve(`Command error: ${err.message}`);
        });
    });
}

// Executes the tool: requests approval, waits, runs or rejects.
// Returns { result, isDenied } for the agent loop to add as a tool message.
async function execute({ command }, { replyFn, typing, messages, meta, client, signal }) {
    console.log(`[EXEC] Requested: ${command}`);
    typing.stop();

    const { id, promise } = await createPendingApproval(
        command,
        meta.source ?? "unknown",
        meta.username ?? "unknown",
        messages,
        client,
    );

    // If the generation is killed while waiting for approval, auto-deny.
    const onAbortWaiting = () => {
        console.log(`[EXEC] Abort signal while awaiting approval — auto-denying ${id}.`);
        resolvePendingApproval(id, { accepted: false, reason: "generation was killed" });
    };
    if (signal) signal.addEventListener("abort", onAbortWaiting, { once: true });

    await replyFn(
        `⚠️ Command requested:\n\`${command}\`\n` +
        `Use \`/approve decide\` with ID \`${id}\` to accept or deny.`
    );

    console.log(`[EXEC] Waiting for approval (id=${id})...`);
    const decision = await promise;
    if (signal) signal.removeEventListener("abort", onAbortWaiting);
    console.log(`[EXEC] Approval resolved (id=${id}):`, decision);

    if (!decision.accepted) {
        typing.restart();
        return { result: `Denied: ${decision.reason}`, isDenied: true };
    }

    // Run the command — spawn so it's killable via signal.
    console.log(`[EXEC] Running: ${command}`);
    const output = await runCommand(command, signal);
    typing.restart();
    return { result: output, isDenied: false };
}

// Called by the /approve decide handler to resolve a pending request.
// No longer runs the command itself — execution happens in execute() above.
function approve(id, decision, _command, reason) {
    resolvePendingApproval(id, decision === "accept"
    ? { accepted: true }
    : { accepted: false, reason: reason || "denied by owner" }
    );
}

module.exports = { definition, execute, approve };
