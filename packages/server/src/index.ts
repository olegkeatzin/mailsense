import type { Config, SecretStore } from "@mailsense/core";
import { initApp, startMailScheduler, logger } from "@mailsense/core";
import {
  cleanupSessions,
  docflowDatabaseUrl,
  initDocflowDb,
  installLdapSettingsStore,
  isDocflowEnabled,
  recomputeUserStats,
  seedLocalAdmin
} from "@mailsense/docflow";
import { createApp } from "./app.js";
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
    // Сервер становится владельцем настроек каталога: их задаёт предприятие,
    // пользователю остаётся ввести только свой логин и пароль.
    await installLdapSettingsStore();
    try {
      await cleanupSessions();
      await seedLocalAdmin();
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
