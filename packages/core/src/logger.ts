import pino from "pino";
import fs from "node:fs";
import path from "node:path";

export let logger: pino.Logger = pino({
  level: process.env.MAILSENSE_LOG_LEVEL ?? "info"
});

/** Подключает запись логов в файл <dataDir>/logs/mailsense.log (в дополнение к stdout). */
export function setupFileLogging(dataDir: string): void {
  try {
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const dest = pino.destination(path.join(logDir, "mailsense.log"));
    logger = pino(
      { level: process.env.MAILSENSE_LOG_LEVEL ?? "info" },
      pino.multistream([{ stream: process.stdout }, { stream: dest }])
    );
    logger.info({ file: path.join(logDir, "mailsense.log") }, "Логирование в файл включено");
  } catch (err) {
    console.error("Не удалось включить файловое логирование:", (err as Error).message);
  }
}

/** Ловит необработанные ошибки, чтобы они попадали в лог. */
export function setupErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    try {
      logger.error({ err: err.message, stack: err.stack }, "Uncaught exception");
    } catch {
      /* ignore */
    }
  });
  process.on("unhandledRejection", (reason) => {
    try {
      logger.error({ reason: String(reason) }, "Unhandled rejection");
    } catch {
      /* ignore */
    }
  });
}

export type Logger = pino.Logger;
