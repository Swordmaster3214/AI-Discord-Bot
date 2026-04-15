const fs = require("fs");

function detectOS() {
    const platform = process.platform;
    if (platform === "win32") return "Windows";
    if (platform === "darwin") return "macOS";
    if (platform === "linux") {
        try {
            const osRelease = fs.readFileSync("/etc/os-release", "utf8");
            const name = (osRelease.match(/^NAME="?([^"\n]+)"?/m) || [])[1] || "Linux";
            const idLike = (osRelease.match(/^ID_LIKE="?([^"\n]+)"?/m) || [])[1] || "";
            const familyMap = {
                arch: "Arch-based", debian: "Debian-based", ubuntu: "Ubuntu-based",
                fedora: "Fedora-based", rhel: "RHEL-based", suse: "openSUSE-based",
                gentoo: "Gentoo-based", alpine: "Alpine-based", void: "Void-based",
            };
            const tokens = idLike.toLowerCase().split(/\s+/);
            const family = tokens.map(t => familyMap[t]).find(Boolean);
            return family ? `${name} (${family})` : name;
        } catch {
            return "Linux";
        }
    }
    return platform;
}

const OS = detectOS();
console.log(`[SYSTEM] Detected OS: ${OS}`);

module.exports = { OS };
