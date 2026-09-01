import { app, BrowserWindow, safeStorage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@mailsense/server";
import { NodeSecretStore, type SecretStore } from "@mailsense/core";

// AppImage монтируется через FUSE без setuid → SUID-песочница Chromium недоступна.
// Отключаем её только в AppImage-контексте; рендерер остаётся изолированным
// (contextIsolation: true, nodeIntegration: false).
if (process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

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

app.whenReady().then(async () => {
  const server = await bootstrap();
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "MailSense — Почтовый помощник",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadURL(server.url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
