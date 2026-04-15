module.exports = {
  apps : [{
    name         : "main",
    script       : "./main.js",
    watch        : true,
    ignore_watch : [
      "node_modules",
      "config.json",
      "**/.*",
      "**/*.kate-swp",
      "memory.db",
      "memory.db-journal"
    ]
  }]
}
