import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const workbench = path.join(root, "Workbench");
const clientSrc = path.join(workbench, "dist", "client");
const distApp = path.join(__dirname, "dist-app");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1. ensure client build exists
if (!fs.existsSync(path.join(clientSrc, "index.html"))) {
  console.error("client build not found. Run `npm run build:client` first.");
  process.exit(1);
}

// 2. clean dist-app
fs.rmSync(distApp, { recursive: true, force: true });
fs.mkdirSync(distApp, { recursive: true });

// 3. copy files
fs.copyFileSync(path.join(__dirname, "main.mjs"), path.join(distApp, "main.mjs"));
copyDir(clientSrc, path.join(distApp, "client"));
copyDir(path.join(workbench, "server"), path.join(distApp, "server"));
copyDir(path.join(workbench, "shared"), path.join(distApp, "shared"));
if (fs.existsSync(path.join(__dirname, "assets"))) {
  copyDir(path.join(__dirname, "assets"), path.join(distApp, "assets"));
}

// 4. write staged package.json
const staged = {
  name: "personal-ai-workbench",
  productName: "个人AI工作台",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "main.mjs",
  author: "sihang",
  devDependencies: {
    "electron": "33.4.11"
  },
  dependencies: {
    "gray-matter": "^4.0.3",
    "mdast-util-to-string": "^4.0.0",
    "remark-gfm": "^4.0.1",
    "remark-parse": "^11.0.0",
    "unified": "^11.0.5",
    "xlsx": "^0.18.5"
  },
  build: {
    appId: "com.sihang.personal-ai-workbench",
    productName: "个人AI工作台",
    asar: true,
    files: [
      "main.mjs",
      "client/**/*",
      "server/**/*",
      "shared/**/*",
      "node_modules/**/*"
    ],
    mac: {
      target: [{ target: "dmg", arch: ["arm64"] }],
      category: "public.app-category.productivity"
    },
    dmg: { title: "个人AI工作台" }
  }
};
if (fs.existsSync(path.join(distApp, "assets", "icon.icns"))) {
  staged.build.mac.icon = "assets/icon.icns";
}
fs.writeFileSync(
  path.join(distApp, "package.json"),
  JSON.stringify(staged, null, 2) + "\n",
);

// 5. install runtime deps into dist-app
console.log("Installing runtime dependencies into dist-app ...");
execSync("npm install --omit=dev --no-audit --no-fund", {
  cwd: distApp,
  stdio: "inherit",
});

console.log("Staged app ready at", distApp);
