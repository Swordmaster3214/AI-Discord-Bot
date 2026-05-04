const fs = require("fs");

const CONFIG_PATH = "./config.json";

// ── Defaults (the base layer every resolved config starts from) ───────────────
//
// Three groups:
//   settings — mode/model/context (the "what" of bot behaviour)
//   tools    — which tools are enabled
//   policy   — who may perform each action
//              roles: "owner" | "admin" (ManageGuild or owner) | "everyone"
//
const DEFAULTS = {
    settings: {
        mode:    "slash",    // "slash" | "mention" | "auto" | "none"
        model:   null,       // null = process.env.DEFAULT_MODEL
        context: "channel",  // "channel" | "guild"  (guild contexts only)
    },
    tools: {
        exec:     false,
        search:   false,
        thinking: false,
        file:     false,
        runCode:  false,
        fetch:    false,
    },
    policy: {
        configure:    "admin",    // /config command
        clearContext: "everyone", // /clearcontext
        gaslight:     "admin",    // /gaslight
        model:        "admin",    // /config model
    },
};

// Exported so callers can enumerate valid keys without hard-coding them.
const TOOL_KEYS    = Object.keys(DEFAULTS.tools);
const POLICY_KEYS  = Object.keys(DEFAULTS.policy);
const SETTING_KEYS = Object.keys(DEFAULTS.settings);

// ── Storage schema ─────────────────────────────────────────────────────────────
//
//  {
//    ollamaTimeout: number,
//    guilds: {
//      [guildId]: {
//        settings?: Partial<settings>,
//        tools?:    Partial<tools>,
//        policy?:   Partial<policy>,
//        channels?: {
//          [channelId]: {
//            settings?: Partial<settings>,
//            tools?:    Partial<tools>,
//            policy?:   Partial<policy>,
//          }
//        }
//      }
//    },
//    dms:      { [userId]:    { settings?, tools? } },
//    groupDms: { [channelId]: { settings?, tools? } },
//  }
//
// Only overrides are stored. Resolution (below) merges layers at read time.

// ── Load / save ───────────────────────────────────────────────────────────────
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        const seed = { ollamaTimeout: 90_000, guilds: {}, dms: {}, groupDms: {} };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
        return seed;
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!cfg.guilds)                     cfg.guilds      = {};
    if (!cfg.dms)                        cfg.dms         = {};
    if (!cfg.groupDms)                   cfg.groupDms    = {};
    if (cfg.ollamaTimeout === undefined) cfg.ollamaTimeout = 90_000;
    return cfg;
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ── Resolution ─────────────────────────────────────────────────────────────────
//
// Returns a fully-resolved config for a location by layering:
//   DEFAULTS → guild → channel   (for guild channels / threads)
//   DEFAULTS → dm/groupDm        (for direct messages)
//
// The returned object always has the complete shape of DEFAULTS; callers can
// read any key without null-checking.
//
function resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId = null) {
    const out = {
        settings: { ...DEFAULTS.settings },
        tools:    { ...DEFAULTS.tools    },
        policy:   { ...DEFAULTS.policy   },
    };

    function applyLayer(layer) {
        if (!layer) return;
        if (layer.settings) Object.assign(out.settings, layer.settings);
        if (layer.tools)    Object.assign(out.tools,    layer.tools);
        if (layer.policy)   Object.assign(out.policy,   layer.policy);
    }

    if (!guildId) {
        const ns = isGroupDM ? config.groupDms : config.dms;
        applyLayer(isGroupDM ? ns[channelId] : ns[userId]);
        return out;
    }

    const guild = config.guilds[guildId];
    if (!guild) return out;

    applyLayer(guild);

    // Channel layer — exact match first, then parent (for threads)
    applyLayer(guild.channels?.[channelId] ?? guild.channels?.[parentChannelId]);

    return out;
}

// ── isChannelOpen ─────────────────────────────────────────────────────────────
//
// A guild channel is "open" when the guild has any config stored, OR when the
// channel/thread itself has config. Without any config the bot stays silent —
// default-closed semantics preserved.
//
// DMs are always open; mode checked after resolution.
//
function isChannelOpen(guildId, channelId, userId, isGroupDM, parentChannelId = null) {
    if (!guildId) return true;

    const guild = config.guilds[guildId];
    if (!guild) return false;

    const hasGuildLayer   = !!(guild.settings || guild.tools);
    const hasChannelLayer = !!(guild.channels?.[channelId] ||
    (parentChannelId && guild.channels?.[parentChannelId]));
    return hasGuildLayer || hasChannelLayer;
}

// ── Context key ───────────────────────────────────────────────────────────────
//
// Pass the already-resolved settings (resolvedConfig.settings) to avoid
// re-resolving. Falls back to "channel" scope if settings not provided.
//
function getContextKey(guildId, channelId, userId, isGroupDM, resolvedSettings = null) {
    if (!guildId) return isGroupDM ? `gdm:${channelId}` : `dm:${userId}`;
    const scope = resolvedSettings?.context ?? DEFAULTS.settings.context;
    return scope === "guild" ? `guild:${guildId}` : `channel:${channelId}`;
}

// ── Mutation helpers ──────────────────────────────────────────────────────────
//
// group = "settings" | "tools" | "policy"
// channelId = null  →  write to guild layer
// channelId = id    →  write to channel layer inside the guild
//
function _ensureGuildChannel(guildId, channelId) {
    if (!config.guilds[guildId])                       config.guilds[guildId]              = {};
    if (!config.guilds[guildId].channels)              config.guilds[guildId].channels     = {};
    if (!config.guilds[guildId].channels[channelId])   config.guilds[guildId].channels[channelId] = {};
    return config.guilds[guildId].channels[channelId];
}

function _ensureGuild(guildId) {
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    return config.guilds[guildId];
}

function setGuildValue(guildId, channelId, group, key, value) {
    const target = channelId
    ? _ensureGuildChannel(guildId, channelId)
    : _ensureGuild(guildId);
    if (!target[group]) target[group] = {};
    target[group][key] = value;
    saveConfig(config);
}

function setDmValue(userId, isGroupDM, channelId, group, key, value) {
    const ns = isGroupDM ? config.groupDms : config.dms;
    const id = isGroupDM ? channelId : userId;
    if (!ns[id])        ns[id]        = {};
    if (!ns[id][group]) ns[id][group] = {};
    ns[id][group][key] = value;
    saveConfig(config);
}

// ── Reset helpers ─────────────────────────────────────────────────────────────
//
// Resetting removes stored overrides so the location reverts to inheriting
// from its parent layer (channel → guild → defaults, guild → defaults).
//
function resetGuild(guildId) {
    delete config.guilds[guildId];
    saveConfig(config);
}

function resetChannel(guildId, channelId) {
    if (config.guilds[guildId]?.channels) {
        delete config.guilds[guildId].channels[channelId];
        saveConfig(config);
    }
}

function resetDm(userId, isGroupDM, channelId) {
    const ns = isGroupDM ? config.groupDms : config.dms;
    const id = isGroupDM ? channelId : userId;
    delete ns[id];
    saveConfig(config);
}

// ── Model resolution (shorthand) ──────────────────────────────────────────────
function resolveModel(guildId, channelId, userId, isGroupDM, parentChannelId = null) {
    return resolveConfig(guildId, channelId, userId, isGroupDM, parentChannelId)
    .settings.model ?? process.env.DEFAULT_MODEL ?? "llama3.1:8b-instruct-q4_K_M";
}

module.exports = {
    config, saveConfig, loadConfig,
    DEFAULTS, TOOL_KEYS, POLICY_KEYS, SETTING_KEYS,
    resolveConfig, isChannelOpen, getContextKey,
    setGuildValue, setDmValue,
    resetGuild, resetChannel, resetDm,
    resolveModel,
};
