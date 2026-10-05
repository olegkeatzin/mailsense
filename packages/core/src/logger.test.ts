/**
 * Обработчики фатальных ошибок. Найденный дефект: uncaughtException только
 * писался в лог, а процесс продолжал работу — после необработанного исключения
 * состояние неизвестно (битые соединения, полупустые транзакции), и сервер молча
 * отвечает ошибками вместо честного падения.
 */
import { logger, setupErrorHandlers } from "./logger.js";

type FatalHandler = (err: Error, origin: string) => void;
type RejectionHandler = (reason: unknown, promise: Promise<unknown>) => void;

/** Слушатель, который добавил именно setupErrorHandlers. */
function addedListeners<T>(event: string, before: Set<unknown>): T[] {
  return (process.listeners(event as "uncaughtException") as unknown[]).filter((l) => !before.has(l)) as T[];
}

describe("фатальные ошибки", () => {
  test("uncaughtException попадает в лог и завершает процесс", async () => {
    const before = new Set(process.listeners("uncaughtException"));
    setupErrorHandlers();
    const added = addedListeners<FatalHandler>("uncaughtException", before);
    expect(added).toHaveLength(1);

    const logSpy = jest.spyOn(logger, "error").mockImplementation((() => undefined) as never);
    const exits: Array<number | undefined> = [];
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exits.push(code);
        return undefined as never;
      }) as never);

    try {
      added[0](new Error("база упала"), "uncaughtException");

      // Причина обязана попасть в лог — иначе сбой нечем разбирать.
      const logged = JSON.stringify(logSpy.mock.calls);
      expect(logged).toContain("база упала");
      expect(logged).toContain("Uncaught exception");

      // Запись асинхронная: даём ей уйти и только потом ждём завершения.
      await new Promise((r) => setTimeout(r, 300));
      // Код 1 — признак сбоя: супервизор (systemd/Electron) должен это увидеть.
      expect(exits).toEqual([1]);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      process.removeListener("uncaughtException", added[0]);
    }
  });

  test("unhandledRejection пишется в лог, но процесс не роняет", async () => {
    // Осознанная асимметрия: отклонённый промис фоновой задачи (планировщик,
    // скан) не означает, что процесс в неопределённом состоянии.
    const before = new Set(process.listeners("unhandledRejection"));
    setupErrorHandlers();
    const added = addedListeners<RejectionHandler>("unhandledRejection", before);
    expect(added).toHaveLength(1);

    const logSpy = jest.spyOn(logger, "error").mockImplementation((() => undefined) as never);
    const exits: Array<number | undefined> = [];
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exits.push(code);
        return undefined as never;
      }) as never);

    try {
      added[0](new Error("фоновая задача упала"), Promise.resolve());
      expect(JSON.stringify(logSpy.mock.calls)).toContain("фоновая задача упала");

      await new Promise((r) => setTimeout(r, 300));
      expect(exits).toEqual([]);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      process.removeListener("unhandledRejection", added[0]);
    }
  });
});
