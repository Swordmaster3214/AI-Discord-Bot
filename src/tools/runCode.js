const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const definition = { type: "function", function: {
    name: "run_code",
    description: "Execute a Python or Node.js snippet. Returns stdout/stderr. Timeout 10s.",
    parameters: { type: "object", properties: {
        language: { type: "string", enum: ["python","node"] },
        code:     { type: "string" },
    }, required: ["language","code"] },
}};

async function execute({ language, code }) {
    const ext  = language === "python" ? ".py" : ".js";
    const bin  = language === "python" ? "python3" : "node";
    const tmp  = path.join(os.tmpdir(), `bot_run_${Date.now()}${ext}`);
    fs.writeFileSync(tmp, code);
    try {
        const out = execSync(`${bin} ${tmp}`, { timeout: 10000, encoding: "utf8" });
        return out.trim() || "(no output)";
    } catch(e) {
        return `Error: ${e.stderr ?? e.message}`;
    } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = { definition, execute };
