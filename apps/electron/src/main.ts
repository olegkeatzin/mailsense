import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
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

async function bootstrap() {
  const dataDir = app.getPath("userData");
  const secretStore = new SafeStorageSecretStore(dataDir);
  const webDist = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(app.getAppPath(), "../../packages/web/dist");
  startupLog("bootstrap dataDir=" + dataDir + " webDist=" + webDist + " webDistExists=" + fs.existsSync(webDist));
  const started = await startServer({ dataDir, webDist, secretStore });
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
