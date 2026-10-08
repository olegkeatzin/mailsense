import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { startServer } from "./index.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * T48: старт сервера обязан применить политику включения документооборота.
 *
 * Проводка важна не меньше самой политики: один раз правка index.ts тихо не применилась,
 * и на живом стенде это выглядело как «правило есть, а эффекта нет».
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

const ENV_KEY = "MAILSENSE_DOCFLOW_ENABLED";

async function boot() {
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 25));
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[ENV_KEY];
  mockedCore.initApp.mockReturnValue({ config: { docflowServerUrl: null, port: 0, host: "127.0.0.1" } });
  mockedCore.startMailScheduler.mockReturnValue(undefined);
  mockedDocflow.docflowDatabaseUrl.mockReturnValue("postgres://test:test@127.0.0.1:55432/test");
  mockedDocflow.getSetting.mockResolvedValue(null);
  mockedDocflow.isDocflowEnabled.mockResolvedValue(true);
});

afterAll(() => {
  delete process.env[ENV_KEY];
});

describe("старт в серверном режиме", () => {
  test("свежая база: документооборот включается на старте", async () => {
    const server = await boot();
    try {
      expect(mockedDocflow.setDocflowEnabled).toHaveBeenCalledWith(true);
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("явная настройка администратора не перетирается", async () => {
    mockedDocflow.getSetting.mockResolvedValue("false");

    const server = await boot();
    try {
      expect(mockedDocflow.setDocflowEnabled).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("MAILSENSE_DOCFLOW_ENABLED=false подавляет автовключение и НИЧЕГО не пишет", async () => {
    process.env[ENV_KEY] = "false";

    const server = await boot();
    try {
      expect(mockedDocflow.setDocflowEnabled).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("false не отменяет настройку администратора: true в базе остаётся true", async () => {
    process.env[ENV_KEY] = "false";
    mockedDocflow.getSetting.mockResolvedValue("true");

    const server = await boot();
    try {
      expect(mockedDocflow.setDocflowEnabled).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });
});

describe("старт без базы документооборота (локальный режим)", () => {
  test("документооборот не включаем", async () => {
    mockedDocflow.docflowDatabaseUrl.mockReturnValue(null);

    const server = await boot();
    try {
      expect(mockedDocflow.setDocflowEnabled).not.toHaveBeenCalled();
      // И база документооборота не поднимается вовсе: это почтовый клиент.
      expect(mockedDocflow.initDocflowDb).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });
});
