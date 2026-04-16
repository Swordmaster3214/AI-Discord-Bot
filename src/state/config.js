const fs = require("fs");

const CONFIG_PATH = "./config.json";

// Global defaults — these become fallbacks when no per-channel config exists.
// terminationMode is kept for config compatibility but is not used by the native
// tool calling agent loop; it remains meaningful only in schema-fallback mode.
const defaultConfig = {
    ollamaTimeout: 90000, // ms, 0 = no timeout
    guilds:    {},
    dms:       {},
    groupDms:  {},
    channelDefaults: {
        mode:            "slash",
        execEnabled:     false,
        browsingEnabled: false,
        thinkingEnabled: false,
        fileEnabled:     false,
        runCodeEnabled:  true,
        fetchEnabled:    false,
    },
    // guilds: { [guildId]: {
    //   contextScope: "local"|"global",
    //   clearPermission: "everyone"|"manager",
    //   modelPermission: "everyone"|"manager",
    //   model?: string,
    //   channels: { [channelId]: {
    //     mode, execEnabled, browsingEnabled, thinkingEnabled,
    //     clearPermission?: "everyone"|"manager"
    //   }}
    // }}
    // dms:      { [userId]:    { mode, execEnabled, browsingEnabled, thinkingEnabled, model? } }
    // groupDms: { [channelId]: { mode, execEnabled, browsingEnabled, thinkingEnabled, model? } }
};

function backfillChannelEntry(ch) {
    const d = defaultConfig.channelDefaults;
    if (!ch.mode)                       ch.mode            = d.mode;
    if (ch.execEnabled     === undefined) ch.execEnabled     = d.execEnabled;
    if (ch.browsingEnabled === undefined) ch.browsingEnabled = d.browsingEnabled;
    if (ch.thinkingEnabled === undefined) ch.thinkingEnabled = d.thinkingEnabled;
    if (ch.fileEnabled    === undefined) ch.fileEnabled    = d.fileEnabled;
    if (ch.runCodeEnabled === undefined) ch.runCodeEnabled = d.runCodeEnabled;
    if (ch.fetchEnabled   === undefined) ch.fetchEnabled   = d.fetchEnabled;
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH));
    if (!cfg.guilds)                      cfg.guilds        = {};
    if (!cfg.dms)                         cfg.dms           = {};
    if (!cfg.groupDms)                    cfg.groupDms      = {};
    if (cfg.ollamaTimeout === undefined)  cfg.ollamaTimeout = defaultConfig.ollamaTimeout;

    for (const dm  of Object.values(cfg.dms))      backfillChannelEntry(dm);
    for (const gdm of Object.values(cfg.groupDms)) backfillChannelEntry(gdm);
    for (const guild of Object.values(cfg.guilds)) {
        if (!guild.channels)         guild.channels        = {};
        if (!guild.contextScope)     guild.contextScope    = "local";
        if (!guild.clearPermission)     guild.clearPermission    = "everyone";
        if (!guild.modelPermission)     guild.modelPermission    = "manager";
        if (!guild.gaslightPermission)  guild.gaslightPermission = "manager";
        for (const ch of Object.values(guild.channels)) backfillChannelEntry(ch);
    }
    return cfg;
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ── Guild config ──────────────────────────────────────────────────────────────
function getGuildConfig(guildId) {
    if (!config.guilds[guildId]) {
        config.guilds[guildId] = {
            contextScope: "local", clearPermission: "everyone",
            modelPermission: "manager", gaslightPermission: "manager", channels: {},
        };
    }
    const guild = config.guilds[guildId];
    if (!guild.channels)             guild.channels          = {};
    if (!guild.contextScope)         guild.contextScope      = "local";
    if (!guild.clearPermission)      guild.clearPermission   = "everyone";
    if (!guild.modelPermission)      guild.modelPermission   = "manager";
    if (!guild.gaslightPermission)   guild.gaslightPermission = "manager";
    return guild;
}

// ── Channel / DM config ───────────────────────────────────────────────────────
function getChannelConfig(guildId, channelId, userId, isGroupDM, parentChannelId = null) {
    const defaults = { ...defaultConfig.channelDefaults };
    if (!guildId) {
        if (isGroupDM) {
            if (!config.groupDms[channelId]) return defaults;
            return Object.assign({}, defaults, config.groupDms[channelId]);
        }
        if (!config.dms[userId]) return defaults;
        return Object.assign({}, defaults, config.dms[userId]);
    }
    const guild = getGuildConfig(guildId);
    if (guild.channels[channelId])   return Object.assign({}, defaults, guild.channels[channelId]);
    if (parentChannelId && guild.channels[parentChannelId])
        return Object.assign({}, defaults, guild.channels[parentChannelId]);
    return defaults;
}

function setChannelConfig(guildId, channelId, key, value, userId, isGroupDM) {
    if (!guildId) {
        if (isGroupDM) {
            if (!config.groupDms[channelId]) config.groupDms[channelId] = { ...defaultConfig.channelDefaults };
            config.groupDms[channelId][key] = value;
        } else {
            if (!config.dms[userId]) config.dms[userId] = { ...defaultConfig.channelDefaults };
            config.dms[userId][key] = value;
        }
    } else {
        const guild = getGuildConfig(guildId);
        if (!guild.channels[channelId]) guild.channels[channelId] = { ...defaultConfig.channelDefaults };
        guild.channels[channelId][key] = value;
    }
    saveConfig(config);
}

// ── Context key ───────────────────────────────────────────────────────────────
function getContextKey(guildId, channelId, userId, isGroupDM) {
    if (!guildId) {
        if (isGroupDM) return `gdm:${channelId}`;
        return `dm:${userId}`;
    }
    const guild = getGuildConfig(guildId);
    if (guild.contextScope === "global") return `guild:${guildId}`;
    return `channel:${channelId}`;
}

// ── Model resolution ──────────────────────────────────────────────────────────
// Resolves the active model for a conversation: guild/DM override, then global default.
function resolveModel(guildId, contextKey, defaultModel) {
    if (guildId) return config.guilds[guildId]?.model ?? defaultModel;
    if (contextKey.startsWith("gdm:")) return config.groupDms[contextKey.slice(4)]?.model ?? defaultModel;
    return config.dms[contextKey.slice(3)]?.model ?? defaultModel;
}

module.exports = {
    defaultConfig, config, loadConfig, saveConfig,
    getGuildConfig, getChannelConfig, setChannelConfig,
    getContextKey, resolveModel,
};
