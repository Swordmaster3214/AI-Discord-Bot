const axios = require("axios");

const READABLE_EXTENSIONS = new Set([
    "txt", "md", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rb", "rs", "go", "java", "c", "cpp", "h", "cs",
    "json", "yaml", "yml", "toml", "ini", "env", "sh", "bash",
    "zsh", "fish", "ps1", "css", "html", "xml", "svg", "sql",
    "graphql", "gql", "dockerfile", "makefile", "lock",
]);
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSIONS    = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MAX_TEXT_BYTES   = 8 * 1024;  // 8KB per text file
const MAX_IMAGE_BYTES  = 5 * 1024 * 1024; // 5MB per image

function ext(attachment) {
    return attachment.name?.split(".").pop()?.toLowerCase() ?? "";
}

function isReadableAttachment(att) {
    if (att.contentType?.startsWith("text/")) return true;
    return READABLE_EXTENSIONS.has(ext(att));
}

function isImageAttachment(att) {
    if (IMAGE_CONTENT_TYPES.has(att.contentType)) return true;
    return IMAGE_EXTENSIONS.has(ext(att));
}

// Returns a combined text string from all readable text attachments.
async function readTextAttachments(attachments) {
    const readable = [...attachments.values()].filter(isReadableAttachment);
    if (readable.length === 0) return "";
    const parts = await Promise.all(readable.map(async att => {
        try {
            const res = await axios.get(att.url, {
                responseType: "text", maxContentLength: MAX_TEXT_BYTES, timeout: 8000,
            });
            const text = typeof res.data === "string" ? res.data : String(res.data);
            return `[Attached file: ${att.name}]\n${text.trim()}`;
        } catch (err) {
            console.warn(`[ATTACH] Could not read ${att.name}: ${err.message}`);
            return null;
        }
    }));
    return parts.filter(Boolean).join("\n\n");
}

// Returns an array of base64 strings for all image attachments.
async function readImageAttachments(attachments) {
    const images = [...attachments.values()].filter(isImageAttachment);
    if (images.length === 0) return [];
    const results = await Promise.all(images.map(async att => {
        try {
            const res = await axios.get(att.url, {
                responseType: "arraybuffer", maxContentLength: MAX_IMAGE_BYTES, timeout: 15000,
            });
            const b64 = Buffer.from(res.data).toString("base64");
            console.log(`[ATTACH] Image: ${att.name} (${Math.round(res.data.byteLength / 1024)}KB)`);
            return b64;
        } catch (err) {
            console.warn(`[ATTACH] Could not read image ${att.name}: ${err.message}`);
            return null;
        }
    }));
    return results.filter(Boolean);
}

module.exports = { readTextAttachments, readImageAttachments };
