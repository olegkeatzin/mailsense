import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@mailsense/server";
import {
  NodeSecretStore,
  normalizeServerAddress,
  resolveServerAddress,
  serverAddressFromEnv,
  type SecretStore,
  type ServerAddressResolution
} from "@mailsense/core";

// Песочница Chromium: .deb использует SUID chrome-sandbox (after-install.sh ставит setuid).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Иконка окна: в сборке лежит в resources, при запуске из исходников — в assets. */
function windowIconPath(): string | undefined {
  const name = process.platform === "win32" ? "icon.ico" : "icon.png";
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, "..", "assets", name);
  return fs.existsSync(candidate) ? candidate : undefined;
}

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
// Режим тонкого клиента и адрес сервера СЭД (решение Р21, пункт Т6 плана).
//
// Локальный backend поднимается ВСЕГДА: почта живёт на этой машине, в своей базе.
// Если задан адрес сервера, локальный backend лишь ПРОКСИРУЕТ документооборот
// (журнал, пользователи, резолюции) — и окно грузит локальный backend, а не сервер.
//
// Порядок источников адреса (он же в packages/core/src/clientConfig.ts и в его тестах):
//   1) --server=<url>                        — явный аргумент;
//   2) server.json РЯДОМ с исполняемым файлом — конфиг предприятия (администратора);
//   3) server.json в каталоге пользователя     — личная настройка;
//   4) MAILSENSE_SERVER_URL                    — переменная окружения.
// Если файл установки есть, но испорчен — это ошибка, и дальше искать адрес нельзя:
// пользователь не должен молча подключиться не к тому серверу, который ему выдали.
// ---------------------------------------------------------------------------

const SERVER_CONFIG_FILE = "server.json";

/** Каталог установки: server.json кладётся рядом с исполняемым файлом. */
function installConfigPath(): string {
  return path.join(path.dirname(app.getPath("exe")), SERVER_CONFIG_FILE);
}

function userConfigPath(): string {
  return path.join(app.getPath("userData"), SERVER_CONFIG_FILE);
}

/**
 * Содержимое файла или undefined. Разделяем «файла нет» (это норма: автономный режим)
 * и «файл не читается» (это ошибка, о ней надо сказать, а не молчать).
 */
function readConfigFile(file: string): { content?: string; error?: string } {
  try {
    return { content: fs.readFileSync(file, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: "не удалось прочитать " + file + ": " + (err as Error).message };
  }
}

function serverArg(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--server="));
  return arg ? arg.slice("--server=".length) : null;
}

/** Текущее состояние адреса: откуда взят, кто им управляет, что не так. */
function resolveServer(): ServerAddressResolution {
  const install = readConfigFile(installConfigPath());
  if (install.error) {
    return { url: null, source: "install", managedByAdmin: true, error: install.error };
  }
  const user = readConfigFile(userConfigPath());
  if (user.error) {
    return { url: null, source: "user", managedByAdmin: false, error: user.error };
  }
  return resolveServerAddress({
    arg: serverArg(),
    installFile: install.content,
    userFile: user.content,
    // Каноническое имя — MAILSENSE_SERVER_URL; прежнее MAILSENSE_DOCFLOW_URL принимаем,
    // чтобы существующие стенды продолжили работать (см. clientConfig.serverAddressFromEnv).
    env: serverAddressFromEnv(process.env)
  });
}

/** Запись ЛИЧНОГО файла. Админский адрес так не перезаписать — это проверяет вызывающий. */
function writeServerConfig(serverUrl: string | null): void {
  const p = userConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ serverUrl }, null, 2), "utf8");
}

/** Проверка адреса для интерфейса: та же логика, что в ядре (единый источник). */
function normalizeServerUrl(raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("Укажите адрес сервера");
  const url = normalizeServerAddress(value);
  if (!url) throw new Error("Адрес должен начинаться с http:// или https:// и содержать хост");
  return url;
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
  const address = resolveServer();
  if (address.error) {
    // Не падаем: приложение поднимается автономно, причину видно в журнале старта
    // и в интерфейсе (server-config:get отдаёт error и managedByAdmin).
    startupLog(
      "server.json: " +
        address.error +
        " (install=" +
        installConfigPath() +
        ", user=" +
        userConfigPath() +
        ")"
    );
  }
  startupLog(
    "bootstrap dataDir=" +
      dataDir +
      " webDist=" +
      webDist +
      " docflow=" +
      (address.url ?? "(локально)") +
      " source=" +
      (address.source ?? "нет")
  );
  const started = await startServer({
    dataDir,
    webDist,
    secretStore,
    overrides: { docflowServerUrl: address.url }
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
  ipcMain.handle("server-config:get", () => {
    const address = resolveServer();
    return {
      serverUrl: address.url,
      source: address.source,
      managedByAdmin: address.managedByAdmin,
      error: address.error,
      localServerUrl: server?.url ?? null
    };
  });
  // Адрес из файла установки задал администратор: пользователь его не переписывает.
  ipcMain.handle("server-config:set", (_e, url: unknown) => {
    const address = resolveServer();
    if (address.managedByAdmin) {
      startupLog("попытка перезаписать админский адрес отклонена");
      return { ok: false, managedByAdmin: true, error: "Адрес задан администратором — менять его нельзя" };
    }
    const normalized = normalizeServerUrl(String(url ?? ""));
    writeServerConfig(normalized);
    startupLog("адрес сервера документооборота сохранён: " + normalized);
    return { ok: true, serverUrl: normalized };
  });
  ipcMain.handle("server-config:clear", () => {
    const address = resolveServer();
    if (address.managedByAdmin) {
      startupLog("попытка сбросить админский адрес отклонена");
      return { ok: false, managedByAdmin: true, error: "Адрес задан администратором — менять его нельзя" };
    }
    writeServerConfig(null);
    startupLog("адрес сервера документооборота сброшен — журнал локальный");
    return { ok: true, serverUrl: null };
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

      // Windows группирует окна и берёт иконку панели задач по AppUserModelID.
      if (process.platform === "win32") app.setAppUserModelId("ru.mailsense.app");
      mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        title: "MailSense — Почтовый помощник",
        icon: windowIconPath(),
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
      // ⚠️ Вложение открывает СИСТЕМНОЕ приложение, а не окно браузера: ссылка на /api/...
      // уходила во внешний браузер без сессии — «требуется вход в систему» (жалоба заказчика).
      ipcMain.handle("shell:open-file", async (_e, payload: unknown) => {
        const { name, base64 } = (payload ?? {}) as { name?: string; base64?: string };
        if (!name || !base64) return { ok: false, error: "нет данных файла" };
        try {
          const dir = await mkdtemp(join(tmpdir(), "mailsense-"));
          const safe = name.replace(/[\\/:*?"<>|]/g, "_");
          const file = join(dir, safe);
          await writeFile(file, Buffer.from(base64, "base64"));
          const err = await shell.openPath(file);
          return err ? { ok: false, error: err } : { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      });
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
