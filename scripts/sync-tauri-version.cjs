// Reads the version from package.json and writes it to tauri.conf.json.
// Run automatically via release-it's after:bump hook.
const fs = require("fs");
const path = require("path");

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
const tauriConfPath = path.resolve(__dirname, "../src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = pkg.version;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
