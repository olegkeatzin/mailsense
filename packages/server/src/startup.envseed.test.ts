import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { startServer } from "./index.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * T51: засев каталога и служебных ящиков обязан происходить на старте сервера.
 *
 * Проводку проверяем отдельно от логики: один раз правка index.ts тихо не применилась,
 * и на стенде это выглядело как «правило есть, а эффекта нет».
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

const ENV_KEYS = [
  "MAILSENSE_LDAP_URL",
  "MAILSENSE_LDAP_BASE_DN",
  "MAILSENSE_LDAP_LOGIN",
  "MAILSENSE_LDAP_PASSWORD",
  "MAILSENSE_SERVICE_MAILBOX"
];

async function boot() {
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 25));
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockedCore.initApp.mockReturnValue({ config: { docflowServerUrl: null, port: 0, host: "127.0.0.1" } });
  mockedCore.startMailScheduler.mockReturnValue(undefined);
  mockedCore.getAccountByUsername.mockReturnValue({ id: "acc-1", username: "service@mail.test" });
  mockedDocflow.docflowDatabaseUrl.mockReturnValue("postgres://test:test@127.0.0.1:55432/test");
  mockedDocflow.getSetting.mockResolvedValue(null);
  mockedDocflow.isDocflowEnabled.mockResolvedValue(true);
});

afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("старт с окружением", () => {
  test("каталог из переменных записывается, пароль — шифротекстом, без пароля в журнале", async () => {
    process.env.MAILSENSE_LDAP_URL = "ldaps://dc.stand.test:636";
    process.env.MAILSENSE_LDAP_BASE_DN = "DC=stand,DC=test";
    process.env.MAILSENSE_LDAP_LOGIN = "ldap-bind";
    process.env.MAILSENSE_LDAP_PASSWORD = "Секрет123!";

    const server = await boot();
    try {
      expect(mockedDocflow.setSetting).toHaveBeenCalledWith("ldap.url", "ldaps://dc.stand.test:636");
      expect(mockedDocflow.setSetting).toHaveBeenCalledWith("ldap.baseDn", "DC=stand,DC=test");
      expect(mockedDocflow.setSetting).toHaveBeenCalledWith("ldap.passwordEncrypted", "ШИФР:Секрет123!");
      // Пароль не должен появиться ни в одной строке журнала.
      const logged = JSON.stringify(mockedCore.logger.info.mock.calls) + JSON.stringify(mockedCore.logger.warn.mock.calls);
      expect(logged).not.toContain("Секрет123!");
      expect(logged).toContain("Засев из окружения");
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("служебный ящик находится по адресу и записывается ролью", async () => {
    process.env.MAILSENSE_SERVICE_MAILBOX = " Service@Mail.Test ";

    const server = await boot();
    try {
      // Краевые пробелы срезаем сами (значение из .env часто с ними), а РЕГИСТР приводит
      // функция ядра — поэтому дальше уходит уже обрезанное значение.
      expect(mockedCore.getAccountByUsername).toHaveBeenCalledWith("Service@Mail.Test");
      expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith(
        { internal: "acc-1" },
        expect.objectContaining({ name: "Настройки окружения" })
      );
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });

  test("без переменных окружения засев ничего не пишет", async () => {
    const server = await boot();
    try {
      expect(mockedDocflow.setSetting).not.toHaveBeenCalled();
      expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.httpServer.close(() => r(undefined)));
    }
  });
});
