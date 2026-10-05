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

/**
 * Завершает процесс после фатальной ошибки.
 *
 * pino пишет в файл асинхронно, поэтому мгновенный process.exit() потерял бы
 * последнюю запись — а именно она нужна для разбора сбоя. Небольшая задержка
 * даёт записи уйти; код возврата 1 видит супервизор (systemd/Electron).
 */
function exitAfterFatal(): void {
  setTimeout(() => process.exit(1), 50);
}

/**
 * Ловит необработанные ошибки, чтобы они попадали в лог.
 *
 * ⚠️ uncaughtException обязан завершать процесс: после необработанного
 * исключения состояние неизвестно (битые соединения, полупустые транзакции,
 * потерянные письма при скане), и «живой» сервер молча отвечает ошибками.
 * unhandledRejection — другое дело: отклонённый промис фоновой задачи
 * (планировщик, скан) не означает, что процесс в неопределённом состоянии.
 */
export function setupErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    try {
      logger.error({ err: err.message, stack: err.stack }, "Uncaught exception");
    } catch {
      /* ignore */
    }
    exitAfterFatal();
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
