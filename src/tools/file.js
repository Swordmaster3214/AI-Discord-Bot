const fs   = require("fs");
const path = require("path");

const SANDBOX = process.env.FILE_SANDBOX ?? "/tmp/bot-files";
fs.mkdirSync(SANDBOX, { recursive: true });

function safePath(p) {
    const resolved = path.resolve(SANDBOX, p);
    if (!resolved.startsWith(SANDBOX)) throw new Error("Path escape blocked.");
    return resolved;
}

const definition = { type: "function", function: {
    name: "file",
    description: `Read, write, or patch files inside a sandboxed directory.

    Actions:
    read   — return file contents
    write  — overwrite entire file
    patch  — apply targeted edits without full rewrite. Pass 'hunks': array of
    {old: string, new: string}. Each 'old' must match exactly once in
    the file; it is replaced with 'new'. Hunks applied in order.
    Use this for any edit to an existing file — prefer over write.
    list   — list files in a directory
    delete — delete a file`,
    parameters: { type: "object", properties: {
        action:  { type: "string", enum: ["read","write","patch","list","delete"] },
        path:    { type: "string", description: "Relative path inside sandbox" },
        content: { type: "string", description: "Full content (write only)" },
        hunks: {
            type: "array",
            description: "Ordered list of replacements (patch only)",
            items: {
                type: "object",
                properties: {
                    old: { type: "string", description: "Exact string to find (must appear exactly once)" },
                    new: { type: "string", description: "String to replace it with" },
                },
                required: ["old", "new"],
            },
        },
    }, required: ["action","path"] },
}};

async function execute({ action, path: p, content, hunks }) {
    const fp = safePath(p);

    if (action === "read") {
        if (!fs.existsSync(fp)) return `File not found: ${p}`;
        return fs.readFileSync(fp, "utf8");
    }

    if (action === "write") {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content ?? "");
        return `Written: ${p}`;
    }

    if (action === "patch") {
        if (!fs.existsSync(fp)) return `File not found: ${p}`;
        if (!Array.isArray(hunks) || hunks.length === 0) return "No hunks provided.";

        let text = fs.readFileSync(fp, "utf8");
        const errors = [];

        for (let i = 0; i < hunks.length; i++) {
            const { old: oldStr, new: newStr } = hunks[i];

            // Count occurrences — must be exactly 1
            let count = 0, pos = 0;
            while ((pos = text.indexOf(oldStr, pos)) !== -1) { count++; pos++; }

            if (count === 0) {
                errors.push(`Hunk ${i + 1}: old string not found.`);
                continue;
            }
            if (count > 1) {
                errors.push(`Hunk ${i + 1}: old string matches ${count} times — make it more specific.`);
                continue;
            }

            text = text.replace(oldStr, newStr);
        }

        fs.writeFileSync(fp, text);

        if (errors.length > 0) {
            return `Patch partially applied. ${hunks.length - errors.length}/${hunks.length} hunks OK.\nErrors:\n${errors.join("\n")}`;
        }
        return `Patch applied: ${hunks.length} hunk(s) → ${p}`;
    }

    if (action === "list") {
        if (!fs.existsSync(fp)) return `Directory not found: ${p}`;
        return fs.readdirSync(fp).join("\n") || "(empty)";
    }

    if (action === "delete") {
        if (!fs.existsSync(fp)) return `File not found: ${p}`;
        fs.rmSync(fp, { force: true });
        return `Deleted: ${p}`;
    }

    return `Unknown action: ${action}`;
}

module.exports = { definition, execute };
