import type { Config, SecretStore } from "@mailsense/core";
import { getSettingValue, initApp, setSettingValue, startMailScheduler, logger } from "@mailsense/core";
import {
  cleanupSessions,
  docflowDatabaseUrl,
  initDocflowDb,
  installLdapSettingsStore,
  installRoleStore,
  isDocflowEnabled,
  recomputeUserStats,
  seedLocalAdmin
} from "@mailsense/docflow";
import { createApp } from "./app.js";
import { applyDocflowStartupPolicy } from "./docflowStartup.js";
import { seedFromEnvironment, seedMailDefaultsFromEnv } from "./envSeed.js";
import type http from "node:http";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  webDist?: string;
  overrides?: Partial<Config>;
  secretStore?: SecretStore;
}

export interface RunningServer {
  config: Config;
  httpServer: http.Server;
  url: string;
  app: Awaited<ReturnType<typeof createApp>>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const init = initApp(
    options.dataDir ? { ...(options.overrides ?? {}), dataDir: options.dataDir } : options.overrides,
    options.secretStore
  );
  const docflowServerUrl = init.config.docflowServerUrl;

  if (docflowServerUrl) {
    // Режим клиента: почта локальная, документооборот — на удалённом сервере.
    // Локальную базу документооборота не поднимаем: она здесь не нужна и только
    // путала бы (два разных журнала у одного пользователя).
    logger.info({ docflowServerUrl }, "Режим клиента: документооборот на удалённом сервере");
  } else if (docflowDatabaseUrl()) {
    // Автономный сервер: документооборот в PostgreSQL (DOCFLOW_DATABASE_URL),
    // почта при этом остаётся в локальной SQLite рядом, в каталоге данных.
    await initDocflowDb();
    // Засев из окружения (T51): каталог и роли служебных ящиков. Ящики к этому моменту уже
    // засеяны ядром (initApp выше), поэтому ящик можно найти по адресу.
    // ⚠️ Хранилище настроек каталога ставим ПОСЛЕ засева: оно наполняет кэш ядра из базы,
    // и значения из окружения должны попасть в него сразу, а не после перезапуска.
    const seeded = await seedFromEnvironment({ env: process.env, mailboxSeed: init.mailboxSeed });
    logger.info(seeded.summary);
    // Сервер становится владельцем настроек каталога: их задаёт предприятие,
    // пользователю остаётся ввести только свой логин и пароль.
    await installLdapSettingsStore();
  // Реестр ролей из базы: права считаются по ролям, которые завёл администратор.
  await installRoleStore();
    try {
      await cleanupSessions();
      await seedLocalAdmin();
      // T48: серверное развёртывание — это развёртывание СЭД. На свежей базе включаем её сами,
      // иначе вход администратора не работает, а API остаётся открытым (тупик первичной настройки).
      await applyDocflowStartupPolicy({
        serverDatabase: true,
        envValue: process.env.MAILSENSE_DOCFLOW_ENABLED
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Не удалось инициализировать документооборот");
    }
    // Агрегат «профиль исполнителя» (task-18): полный фоновый пересчёт при старте —
    // страховка на случай, если процесс падал до события закрытия поручения.
    void recomputeUserStats()
      .then((r) => logger.info(r, "Агрегат профилей исполнителей пересчитан при старте"))
      .catch((err) =>
        logger.warn(
          { err: (err as Error).message },
          "Не удалось пересчитать агрегат профилей исполнителей при старте"
        )
      );
  } else {
    // База документооборота не задана — приложение работает как почтовый клиент.
    // ⚠️ Умолчания почты нужны и здесь! Раньше засев шёл ТОЛЬКО при наличии
    // DOCFLOW_DATABASE_URL, и в этом режиме MAILSENSE_MAIL_DEFAULTS молча пропадал,
    // а сохранение из интерфейса падало с «проверьте DOCFLOW_DATABASE_URL».
    const mailDefaults = await seedMailDefaultsFromEnv({
      env: process.env,
      readSetting: async (key) => getSettingValue(key) || null,
      writeSetting: async (key, value) => setSettingValue(key, value)
    });
    if (mailDefaults) {
      logger.info(
        { written: mailDefaults.written, skipped: mailDefaults.skipped, warnings: mailDefaults.warnings },
        "Умолчания почты из окружения (локальная база)"
      );
    }
    // Политику всё равно зовём: если оператор задал MAILSENSE_DOCFLOW_ENABLED, он должен
    // увидеть в журнале, что переменная здесь не действует, а не гадать.
    await applyDocflowStartupPolicy({
      serverDatabase: false,
      envValue: process.env.MAILSENSE_DOCFLOW_ENABLED
    });
    logger.info(
      "Документооборот не настроен (нет DOCFLOW_DATABASE_URL) — приложение работает как почтовый клиент"
    );
  }

  const app = await createApp({ webDist: options.webDist, docflowServerUrl });
  startMailScheduler();
  const port = options.port ?? init.config.port;
  const host = options.host ?? init.config.host;

  // Сервер в сети без включённого входа = открытый доступ к почте и журналу.
  // Предупреждаем громко, а не молча выставляем наружу.
  if (!docflowServerUrl && !LOCAL_HOSTS.has(host) && !(await isDocflowEnabled())) {
    logger.warn(
      { host },
      "Сервер слушает сетевой адрес, но документооборот выключен — API доступен без аутентификации. " +
        "Включите его («Настройки → Документооборот») или запускайте на 127.0.0.1"
    );
  }

  return new Promise<RunningServer>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      resolve({
        config: init.config,
        httpServer,
        url: "http://" + host + ":" + port,
        app
      });
    });
    httpServer.on("error", reject);
  });
}

export { createApp };
