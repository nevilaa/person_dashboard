import { app, BrowserWindow, dialog, shell } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { workbenchApiPlugin } from "./server/vite-plugin-workbench.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, "client");

function vaultConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function resolveVaultRoot() {
  if (process.env.PERSONAL_DASHBOARD_VAULT_ROOT) {
    return process.env.PERSONAL_DASHBOARD_VAULT_ROOT;
  }
  try {
    const config = JSON.parse(fs.readFileSync(vaultConfigPath(), "utf8"));
    if (typeof config.vaultRoot === "string" && config.vaultRoot.trim()) {
      return config.vaultRoot.trim();
    }
  } catch {
    // no config yet
  }
  return null;
}

/* ---------- tiny middleware router (connect-compatible) ---------- */
function createRouter() {
  const stack = [];
  const router = (req, res) => {
    let index = 0;
    const next = () => {
      const layer = stack[index++];
      if (!layer) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      try {
        layer(req, res, next);
      } catch (error) {
        console.error(error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      }
    };
    next();
  };
  router.use = (fn) => stack.push(fn);
  return router;
}

/* ---------- minimal chokidar-compatible fs.watch shim ---------- */
function createVaultWatcher() {
  const listeners = new Map();
  let roots = new Set();
  let handles = [];
  const watcher = {
    on(event, fn) {
      listeners.set(event, fn);
      return watcher;
    },
    off(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
      return watcher;
    },
    add(root) {
      roots.add(path.resolve(root));
      start();
      return watcher;
    },
    unwatch(root) {
      roots.delete(path.resolve(root));
      return watcher;
    },
    close() {
      for (const handle of handles) handle.close();
      handles = [];
    },
  };
  const emit = (event, args) => listeners.get(event)?.(event, args);
  let restartTimer = null;
  function start() {
    for (const handle of handles) handle.close();
    handles = [];
    for (const root of roots) {
      const handle = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const absolute = path.resolve(root, String(filename));
        emit("all", _event, absolute);
      });
      handle.on("error", () => {});
      handles.push(handle);
    }
    clearTimeout(restartTimer);
    restartTimer = setTimeout(start, 60_000);
  }
  return watcher;
}

/* ---------- static file serving with SPA fallback ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

function serveStatic() {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return next();
    }
    let filePath = path.normalize(path.join(CLIENT_DIR, urlPath));
    if (!filePath.startsWith(CLIENT_DIR)) return next();
    if (urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) return next();
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(filePath).pipe(res);
    });
  };
}

function serveSpaFallback() {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    fs.readFile(path.join(CLIENT_DIR, "index.html"), (error, data) => {
      if (error) return next();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  };
}

/* ---------- backend server (reuses the workbench API plugin) ---------- */
async function createBackend(vaultRoot) {
  const router = createRouter();
  const watcher = createVaultWatcher();
  const fakeServer = {
    middlewares: router,
    watcher,
    httpServer: null,
    config: { logger: { error: console.error } },
  };
  const plugin = workbenchApiPlugin({ vaultRoot });
  plugin.configureServer(fakeServer);
  router.use(serveStatic());
  router.use(serveSpaFallback());

  const httpServer = http.createServer((req, res) => router(req, res));
  fakeServer.httpServer = httpServer;
  httpServer.on("close", () => watcher.close());
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return httpServer;
}

/* ---------- app lifecycle ---------- */
let mainWindow = null;

async function createWindow() {
  const vaultRoot = resolveVaultRoot();
  if (!vaultRoot) {
    dialog.showErrorBox(
      "未配置知识库 Vault",
      "请先在以下文件里设置 vaultRoot 指向你的 Obsidian Vault，然后重新打开 App：\n\n" +
        vaultConfigPath(),
    );
    app.quit();
    return;
  }
  const server = await createBackend(vaultRoot);
  const port = server.address().port;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "个人 AI 工作台",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error("Failed to start workbench:", error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
