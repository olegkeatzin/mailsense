import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@mailsense/server";
import { NodeSecretStore, type SecretStore } from "@mailsense/core";

// Песочница Chromium: .deb использует SUID chrome-sandbox (after-install.sh ставит setuid).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return startServer({ dataDir, webDist, secretStore });
}

let server: Awaited<ReturnType<typeof bootstrap>> | null = null;
let mainWindow: BrowserWindow | null = null;

// Один экземпляр: иначе второй запуск конфликтует по порту 8123 и «зависает» без окна.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      server = await bootstrap();
    } catch (err) {
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
    mainWindow.loadURL(server.url);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Закрываем HTTP-сервер, иначе он держит event loop и процесс «висит» после закрытия окна.
    server?.httpServer.close();
    app.quit();
  }
});