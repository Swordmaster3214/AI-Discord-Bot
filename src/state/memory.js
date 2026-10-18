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
const STALE_DAYS     = 30;
const STALE_MS       = STALE_DAYS * 24 * 60 * 60 * 1000;

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
        enabled      INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER
    );
    `);

    // Safe migration for existing installs that don't have last_seen_at yet.
    try {
        db.exec(`ALTER TABLE memory_settings ADD COLUMN last_seen_at INTEGER`);
        console.log("[MEMORY] Migrated memory_settings: added last_seen_at column.");
    } catch {
        // Column already exists, nothing to do.
    }

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

// Bumps last_seen_at for the user — called whenever memories are injected.
// This is what keeps the 30-day staleness timer from firing on active users.
function touchLastSeen(userId) {
    if (!ENABLED) return;
    const hash = hashUserId(userId);
    getDb().prepare(
        `UPDATE memory_settings SET last_seen_at = ? WHERE user_hash = ?`
    ).run(Date.now(), hash);
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

// ── Stale user pruning ────────────────────────────────────────────────────────
// Removes memories (and their settings row) for users who haven't been seen
// in STALE_DAYS days. Runs daily on startup; also exported for owner use.
function pruneStaleUsers() {
    if (!ENABLED) return 0;
    const cutoff  = Date.now() - STALE_MS;
    const database = getDb();

    // last_seen_at NULL means the user opted in before we started tracking it.
    // We treat NULL as "never seen" and consider them stale immediately only if
    // they also have no memories — otherwise we give them a grace period of one
    // more cycle (set last_seen_at to now so they get the full 30 days next time).
    const nullRows = database.prepare(`
    SELECT ms.user_hash
    FROM memory_settings ms
    LEFT JOIN memories m ON m.user_hash = ms.user_hash
    WHERE ms.last_seen_at IS NULL AND m.user_hash IS NULL
    `).all();
    for (const { user_hash } of nullRows) {
        database.prepare(`DELETE FROM memory_settings WHERE user_hash = ?`).run(user_hash);
    }

    // Stamp last_seen_at for users who have memories but no timestamp yet
    // so they get a fresh 30-day window instead of being pruned immediately.
    database.prepare(`
    UPDATE memory_settings SET last_seen_at = ?
    WHERE last_seen_at IS NULL
    `).run(Date.now());

    // Now prune anyone whose last_seen_at is past the cutoff.
    const stale = database.prepare(`
    SELECT user_hash FROM memory_settings WHERE last_seen_at < ?
    `).all(cutoff);

    let total = 0;
    for (const { user_hash } of stale) {
        const result = database.prepare(`DELETE FROM memories WHERE user_hash = ?`).run(user_hash);
        database.prepare(`DELETE FROM memory_settings WHERE user_hash = ?`).run(user_hash);
        total += result.changes;
        if (result.changes > 0) {
            console.log(`[MEMORY] Pruned ${result.changes} stale memories for ${user_hash.slice(0, 16)}… (inactive ${STALE_DAYS}+ days)`);
        }
    }

    return total;
}

// Run once shortly after startup, then every 24 hours.
if (ENABLED) {
    setTimeout(() => {
        const count = pruneStaleUsers();
        if (count > 0) console.log(`[MEMORY] Startup prune: removed ${count} stale memories.`);
    }, 10_000).unref();

    setInterval(() => {
        const count = pruneStaleUsers();
        if (count > 0) console.log(`[MEMORY] Daily prune: removed ${count} stale memories.`);
    }, 24 * 60 * 60 * 1000).unref();
}

// ── Injection builder ─────────────────────────────────────────────────────────
// Formats memories as a system prompt block. Returns empty string if none.
function buildMemoryBlock(userId) {
    if (!ENABLED || !isUserEnabled(userId)) return "";
    const memories = getMemories(userId);
    if (memories.length === 0) return "";

    // User is actively chatting — reset their staleness timer.
    touchLastSeen(userId);

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
    const cutoff   = Date.now() - STALE_MS;
    const users    = database.prepare(
        `SELECT user_hash, COUNT(*) as cnt, last_seen_at
        FROM memories
        JOIN memory_settings USING (user_hash)
        GROUP BY user_hash
        ORDER BY cnt DESC`
    ).all();
    // Tag users who are approaching the stale cutoff (within 7 days).
    const warnMs = 7 * 24 * 60 * 60 * 1000;
    return {
        total,
        staleInDays: STALE_DAYS,
        users: users.map(u => ({
            user_hash:    u.user_hash,
            cnt:          u.cnt,
            last_seen_at: u.last_seen_at,
            nearlyStale:  u.last_seen_at !== null && u.last_seen_at < cutoff + warnMs,
        })),
    };
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
    pruneStaleUsers,
    getStats, clearByHash, getUserHash,
};
