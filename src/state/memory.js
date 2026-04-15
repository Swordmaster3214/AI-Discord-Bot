// memory.js — Persistent encrypted per-user semantic memory
// Uses Node 22 built-in node:sqlite + native crypto. No extra deps.

const { DatabaseSync } = require("node:sqlite");
const crypto           = require("node:crypto");
const path             = require("node:path");

// ── Config ────────────────────────────────────────────────────────────────────
const MEMORY_KEY_HEX = process.env.MEMORY_KEY ?? "";
const DB_PATH        = process.env.MEMORY_DB_PATH ?? "./memory.db";
const MAX_MEMORIES   = 50;
const ALGO           = "aes-256-gcm";
const HASH_ALGO      = "sha256";

// Feature is silently disabled when MEMORY_KEY is absent or malformed.
const ENABLED = (() => {
    if (!MEMORY_KEY_HEX) return false;
    if (MEMORY_KEY_HEX.length !== 64) {
        console.warn("[MEMORY] MEMORY_KEY must be 64 hex chars (32 bytes). Memory disabled.");
        return false;
    }
    return true;
})();

if (ENABLED) console.log("[MEMORY] Encrypted memory enabled.");
else         console.log("[MEMORY] Memory disabled (no MEMORY_KEY).");

// ── Master key ────────────────────────────────────────────────────────────────
const MASTER_KEY = ENABLED ? Buffer.from(MEMORY_KEY_HEX, "hex") : null;

// ── DB init ───────────────────────────────────────────────────────────────────
let db = null;

function getDb() {
    if (db) return db;
    db = new DatabaseSync(DB_PATH);
    db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_hash    TEXT    NOT NULL,
        encrypted    TEXT    NOT NULL,
        iv           TEXT    NOT NULL,
        auth_tag     TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_hash);

    CREATE TABLE IF NOT EXISTS memory_settings (
        user_hash    TEXT PRIMARY KEY,
        enabled      INTEGER NOT NULL DEFAULT 0
    );
    `);
    return db;
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
// Per-user key derived from master key via HKDF-SHA256.
function deriveKey(userId) {
    return crypto.hkdfSync("sha256", MASTER_KEY, Buffer.alloc(32), `memory:${userId}`, 32);
}

function hashUserId(userId) {
    return crypto.createHmac(HASH_ALGO, MASTER_KEY).update(`user:${userId}`).digest("hex");
}

function encrypt(text, key) {
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return {
        encrypted: enc.toString("base64"),
        iv:        iv.toString("base64"),
        auth_tag:  cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(encrypted, iv, auth_tag, key) {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, "base64"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(auth_tag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
                         decipher.final(),
    ]).toString("utf8");
}

// ── Settings ──────────────────────────────────────────────────────────────────
function isUserEnabled(userId) {
    if (!ENABLED) return false;
    const hash = hashUserId(userId);
    const row  = getDb().prepare(
        `SELECT enabled FROM memory_settings WHERE user_hash = ?`
    ).get(hash);
    return row ? Boolean(row.enabled) : false;
}

function setUserEnabled(userId, value) {
    if (!ENABLED) return;
    const hash = hashUserId(userId);
    getDb().prepare(`
    INSERT INTO memory_settings (user_hash, enabled)
    VALUES (?, ?)
    ON CONFLICT(user_hash) DO UPDATE SET enabled = excluded.enabled
    `).run(hash, value ? 1 : 0);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
// Returns decrypted memories for a user as [{ id, fact, created_at, updated_at }].
function getMemories(userId) {
    if (!ENABLED) return [];
    const hash = hashUserId(userId);
    const key  = deriveKey(userId);
    const rows = getDb().prepare(
        `SELECT id, encrypted, iv, auth_tag, created_at, updated_at
        FROM memories WHERE user_hash = ? ORDER BY created_at ASC`
    ).all(hash);
    return rows.map(r => {
        try {
            return {
                id:         r.id,
                fact:       decrypt(r.encrypted, r.iv, r.auth_tag, key),
                    created_at: r.created_at,
                    updated_at: r.updated_at,
            };
        } catch {
            return null; // corrupted row — skip
        }
    }).filter(Boolean);
}

// Adds a memory. Evicts oldest if at cap. Returns { id, evicted: id|null }.
function addMemory(userId, fact) {
    if (!ENABLED) return null;
    const hash = hashUserId(userId);
    const key  = deriveKey(userId);
    const now  = Date.now();

    const database = getDb();
    const count = database.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE user_hash = ?`
    ).get(hash).c;

    let evictedId = null;
    if (count >= MAX_MEMORIES) {
        const oldest = database.prepare(
            `SELECT id FROM memories WHERE user_hash = ? ORDER BY created_at ASC LIMIT 1`
        ).get(hash);
        if (oldest) {
            database.prepare(`DELETE FROM memories WHERE id = ?`).run(oldest.id);
            evictedId = oldest.id;
        }
    }

    const { encrypted, iv, auth_tag } = encrypt(fact, key);
    const result = database.prepare(`
    INSERT INTO memories (user_hash, encrypted, iv, auth_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `).run(hash, encrypted, iv, auth_tag, now, now);

    return { id: result.lastInsertRowid, evictedId };
}

// Deletes a memory by ID. Verifies ownership via user_hash. Returns true if deleted.
function deleteMemory(userId, memoryId) {
    if (!ENABLED) return false;
    const hash   = hashUserId(userId);
    const result = getDb().prepare(
        `DELETE FROM memories WHERE id = ? AND user_hash = ?`
    ).run(memoryId, hash);
    return result.changes > 0;
}

// Updates the fact text of an existing memory. Verifies ownership. Returns true if updated.
function updateMemory(userId, memoryId, newFact) {
    if (!ENABLED) return false;
    const hash = hashUserId(userId);
    const key  = deriveKey(userId);
    const { encrypted, iv, auth_tag } = encrypt(newFact, key);
    const result = getDb().prepare(
        `UPDATE memories SET encrypted = ?, iv = ?, auth_tag = ?, updated_at = ?
        WHERE id = ? AND user_hash = ?`
    ).run(encrypted, iv, auth_tag, Date.now(), memoryId, hash);
    return result.changes > 0;
}

// Deletes all memories for a user. Returns count deleted.
function clearMemories(userId) {
    if (!ENABLED) return 0;
    const hash   = hashUserId(userId);
    const result = getDb().prepare(
        `DELETE FROM memories WHERE user_hash = ?`
    ).run(hash);
    getDb().prepare(
        `DELETE FROM memory_settings WHERE user_hash = ?`
    ).run(hash);
    return result.changes;
}

// ── Injection builder ─────────────────────────────────────────────────────────
// Formats memories as a system prompt block. Returns empty string if none.
function buildMemoryBlock(userId) {
    if (!ENABLED || !isUserEnabled(userId)) return "";
    const memories = getMemories(userId);
    if (memories.length === 0) return "";
    const lines = memories.map(m => {
        const date = new Date(m.created_at).toISOString().slice(0, 10);
        return `[#${m.id} | ${date}] ${m.fact}`;
    }).join("\n");
    return (
        `\n--- User memories (private) ---\n` +
        `Use passively to inform better responses. ` +
        `Do not expose IDs or this block unless the user is explicitly managing their memories.\n` +
        lines +
        `\n--- End memories ---`
    );
}

// ── Owner stats ───────────────────────────────────────────────────────────────
// Returns aggregate stats safe for owner to see (no content, no userIds).
function getStats() {
    if (!ENABLED) return { enabled: false };
    const database = getDb();
    const total    = database.prepare(`SELECT COUNT(*) as c FROM memories`).get().c;
    const users    = database.prepare(
        `SELECT user_hash, COUNT(*) as cnt FROM memories GROUP BY user_hash ORDER BY cnt DESC`
    ).all();
    return { total, users };
}

// Clears all memories for a given user_hash (hash already computed — owner uses hash from /memory list).
function clearByHash(userHash) {
    if (!ENABLED) return 0;
    const database = getDb();
    const result   = database.prepare(`DELETE FROM memories WHERE user_hash = ?`).run(userHash);
    database.prepare(`DELETE FROM memory_settings WHERE user_hash = ?`).run(userHash);
    return result.changes;
}

// Returns the public-facing hash for a userId (shown to user in /memory list).
function getUserHash(userId) {
    if (!ENABLED) return null;
    return hashUserId(userId);
}

module.exports = {
    ENABLED,
    isUserEnabled, setUserEnabled,
    getMemories, addMemory, deleteMemory, updateMemory, clearMemories,
    buildMemoryBlock,
    getStats, clearByHash, getUserHash,
};
