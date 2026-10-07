import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { startServer } from "./index.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Проводка «полного фонового пересчёта при старте» (task-18).
 *
 * Этот вызов уже один раз ТИХО пропал: правка не легла в файл, я её не проверил, и на живом
 * стенде это выглядело как «агрегат пуст, строки в логе нет». Тест держит проводку:
 * автономный сервер обязан запускать пересчёт, а режим клиента (документооборот удалённый,
 * своей базы нет) — не обязан и не должен.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

const flush = () => new Promise((r) => setTimeout(r, 25));

describe("старт автономного сервера пересчитывает агрегат", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCore.initApp.mockReturnValue({
      config: { docflowServerUrl: null, port: 0, host: "127.0.0.1" }
    });
    mockedCore.startMailScheduler.mockReturnValue(undefined);
    mockedDocflow.docflowDatabaseUrl.mockReturnValue("postgres://test:test@127.0.0.1:55432/test");
    mockedDocflow.isDocflowEnabled.mockResolvedValue(true);
    mockedDocflow.recomputeUserStats.mockResolvedValue({ users: 7, updated: 7, skipped: 0, monthly: 6 });
  });

  test("автономный сервер: при старте запускается фоновый пересчёт", async () => {
    const server = await startServer({ port: 0, host: "127.0.0.1" });
    try {
      await flush();
      expect(mockedDocflow.recomputeUserStats).toHaveBeenCalledTimes(1);
      // Страховка работает и тогда, когда пересчёт падает: старт сервера не должен ломаться.
      expect(mockedCore.logger.info).toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("сбой пересчёта при старте не мешает серверу подняться", async () => {
    mockedDocflow.recomputeUserStats.mockRejectedValueOnce(new Error("БД недоступна"));

    const server = await startServer({ port: 0, host: "127.0.0.1" });
    try {
      await flush();
      expect(server.url).toContain("127.0.0.1");
      expect(mockedCore.logger.warn).toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("режим клиента: своей базы СЭД нет — пересчёт не запускается", async () => {
    mockedCore.initApp.mockReturnValue({
      config: { docflowServerUrl: "http://server.example", port: 0, host: "127.0.0.1" }
    });

    const server = await startServer({ port: 0, host: "127.0.0.1" });
    try {
      await flush();
      expect(mockedDocflow.recomputeUserStats).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });
});
