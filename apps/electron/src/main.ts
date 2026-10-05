import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@mailsense/server";
import { NodeSecretStore, type SecretStore } from "@mailsense/core";

// Песочница Chromium: .deb использует SUID chrome-sandbox (after-install.sh ставит setuid).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Трассировка старта в <userData>/logs/startup.log. Обычный логгер поднимается
 * только внутри startServer (после initDb), поэтому падение на раннем этапе
 * раньше выглядело как «запустил и ничего не произошло» — теперь оно видно.
 */
function startupLog(message: string): void {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "startup.log"), new Date().toISOString() + " " + message + "\n");
  } catch {
    /* ignore */
  }
}

startupLog(
  "main.js loaded pid=" +
    process.pid +
    " packaged=" +
    app.isPackaged +
    " userData=" +
    app.getPath("userData") +
    " resources=" +
    process.resourcesPath
);
process.on("uncaughtException", (err) => startupLog("uncaughtException: " + (err?.stack ?? String(err))));
process.on("unhandledRejection", (reason) =>
  startupLog("unhandledRejection: " + ((reason as Error)?.stack ?? String(reason)))
);

// ---------------------------------------------------------------------------
// Режим тонкого клиента.
//
// Если задан адрес сервера — локальный backend НЕ поднимается, окно грузит
// удалённый сервер (там же живут БД, почта и журнал СЭД). Если адрес не задан,
// поведение прежнее: своё встроенное ядро и локальная база.
//
// Источники адреса по приоритету: аргумент --server=<url>, переменная окружения
// MAILSENSE_SERVER_URL, файл <userData>/server.json.
// ---------------------------------------------------------------------------

const SERVER_CONFIG_FILE = "server.json";

interface ServerConfig {
  serverUrl: string | null;
}

function readServerConfig(): ServerConfig {
  try {
    const p = path.join(app.getPath("userData"), SERVER_CONFIG_FILE);
    if (!fs.existsSync(p)) return { serverUrl: null };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { serverUrl?: string };
    const url = (parsed.serverUrl ?? "").trim();
    return { serverUrl: url || null };
  } catch {
    return { serverUrl: null };
  }
}

function writeServerConfig(serverUrl: string | null): void {
  const p = path.join(app.getPath("userData"), SERVER_CONFIG_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ serverUrl }, null, 2), "utf8");
}

/** Допускаем только http/https — иначе loadURL упадёт невнятно. */
function normalizeServerUrl(raw: string): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("Укажите адрес сервера");
  if (!/^https?:\/\//i.test(url)) throw new Error("Адрес должен начинаться с http:// или https://");
  return url;
}

function cliServerUrl(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--server="));
  if (arg) return arg.slice("--server=".length).trim() || null;
  return (process.env.MAILSENSE_SERVER_URL ?? "").trim() || null;
}

/** safeStorage с фолбэком на файловый AES-ключ (headless/тест). */
class SafeStorageSecretStore implements SecretStore {
  private fallback: NodeSecretStore;

  constructor(dataDir: string) {
    this.fallback = new NodeSecretStore(dataDir);
  }

  encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return "safe:" + safeStorage.encryptString(plain).toString("base64");
    }
    return this.fallback.encrypt(plain);
  }

  decrypt(cipher: string): string {
    if (cipher.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(cipher.slice(5), "base64"));
    }
    return this.fallback.decrypt(cipher);
  }
}

/**
 * Локальный backend поднимается ВСЕГДА: почта живёт на этой машине, в своей базе.
 * Удалённый сервер — это только документооборот (журнал, пользователи, резолюции),
 * и его адрес локальный backend проксирует.
 */
async function bootstrap() {
  const dataDir = app.getPath("userData");
  const secretStore = new SafeStorageSecretStore(dataDir);
  const webDist = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(app.getAppPath(), "../../packages/web/dist");
  const docflowServerUrl = cliServerUrl() ?? readServerConfig().serverUrl;
  startupLog(
    "bootstrap dataDir=" + dataDir + " webDist=" + webDist + " docflow=" + (docflowServerUrl ?? "(локально)")
  );
  const started = await startServer({
    dataDir,
    webDist,
    secretStore,
    overrides: { docflowServerUrl: docflowServerUrl ? normalizeServerUrl(docflowServerUrl) : null }
  });
  startupLog("server started " + started.url);
  return started;
}

let server: Awaited<ReturnType<typeof bootstrap>> | null = null;
let mainWindow: BrowserWindow | null = null;

// Один экземпляр: иначе второй запуск конфликтует по порту 8123 и «зависает» без окна.
const gotTheLock = app.requestSingleInstanceLock();
startupLog("singleInstanceLock=" + gotTheLock);
if (!gotTheLock) {
  startupLog("another instance already running -> quit");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // IPC для настройки адреса сервера документооборота («Настройки → Документооборот»).
  // Почта при этом остаётся локальной — меняется только источник журнала.
  ipcMain.handle("server-config:get", () => ({
    ...readServerConfig(),
    localServerUrl: server?.url ?? null
  }));
  ipcMain.handle("server-config:set", (_e, url: unknown) => {
    const normalized = normalizeServerUrl(String(url ?? ""));
    writeServerConfig(normalized);
    startupLog("адрес сервера документооборота сохранён: " + normalized);
    return { serverUrl: normalized };
  });
  ipcMain.handle("server-config:clear", () => {
    writeServerConfig(null);
    startupLog("адрес сервера документооборота сброшен — журнал локальный");
    return { serverUrl: null };
  });
  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  app
    .whenReady()
    .then(async () => {
      startupLog("app ready");
      try {
        server = await bootstrap();
      } catch (err) {
        startupLog("bootstrap failed: " + ((err as Error)?.stack ?? String(err)));
        dialog.showErrorBox("MailSense", "Не удалось запустить сервер:\n" + (err as Error).message);
        app.quit();
        return;
      }

      mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        title: "MailSense — Почтовый помощник",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false
        }
      });
      mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) =>
        startupLog("did-fail-load code=" + code + " desc=" + desc + " url=" + url)
      );
      mainWindow.webContents.on("render-process-gone", (_e, details) =>
        startupLog("render-process-gone " + JSON.stringify(details))
      );
      // Окно всегда грузит ЛОКАЛЬНЫЙ backend: он отдаёт почту и проксирует документооборот.
      mainWindow.loadURL(server.url).catch((err) => startupLog("loadURL failed: " + (err as Error).message));
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
      });
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
      startupLog("window created, loading " + server.url);
    })
    .catch((err) => startupLog("whenReady failed: " + ((err as Error)?.stack ?? String(err))));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Закрываем HTTP-сервер, иначе он держит event loop и процесс «висит» после закрытия окна.
    server?.httpServer.close();
    app.quit();
  }
});
