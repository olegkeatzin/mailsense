import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { createApp } from "./app.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Умолчания почтового сервера (пункт 5 заказчика).
 *
 * Предприятие задаёт адрес сервера, порты, шифрование и способ входа — работник вводит только
 * адрес ящика и пароль. Проверяем и отдачу умолчаний форме, и подстановку при создании ящика.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const DEFAULTS = {
  pop3: { host: "192.168.1.10", port: 995, tls: "ssl", authType: "login" },
  smtp: { host: "192.168.1.10", port: 465, tls: "ssl", authType: "login" }
};
const TOKEN = "token:worker";
const TOKEN_ADMIN = "token:admin";
let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(TOKEN, testUser("u-ivanov", ["secretary"], { ldapUid: "ivanov" }));
  mockedDocflow.__sessions.set(TOKEN_ADMIN, testUser("u-admin", ["admin"], { ldapUid: "admin" }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Умолчания — настройка предприятия: в серверном режиме их читает docflow из своей базы.
  mockedDocflow.getSetting.mockImplementation(async (key: string) =>
    key === "mail.defaults" ? JSON.stringify(DEFAULTS) : null
  );
  mockedCore.createAccount.mockImplementation((input: Record<string, unknown>) => ({ id: "acc-1", ...input }));
});

describe("умолчания почтового сервера", () => {
  test("форма получает умолчания: адрес, порты, шифрование и способ входа", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-defaults", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  test("умолчания доступны любому вошедшему: это не секрет и не настройка предприятия", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-defaults", { token: TOKEN });
    expect([401, 403]).not.toContain(res.status);
    expect((await request(app.baseUrl, "GET", "/api/mail-defaults")).status).toBe(401);
  });

  test("ящик создаётся с умолчаниями, если работник указал только адрес и пароль", async () => {
    const res = await request(app.baseUrl, "POST", "/api/accounts", {
      token: TOKEN,
      body: { protocol: "pop3", username: "ivanov@kniitmu.ru", password: "почтовый" }
    });

    expect(res.status).toBe(201);
    expect(mockedCore.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "pop3",
        host: "192.168.1.10",
        port: 995,
        tls: "ssl",
        authType: "login",
        smtpHost: "192.168.1.10",
        smtpPort: 465,
        smtpTls: "ssl"
      }),
      "ivanov"
    );
  });

  test("указанное работником не перетирается умолчаниями", async () => {
    await request(app.baseUrl, "POST", "/api/accounts", {
      token: TOKEN,
      body: {
        protocol: "pop3",
        host: "10.168.101.3",
        port: 110,
        tls: "starttls",
        authType: "plain",
        username: "ivanov@kniitmu.ru",
        password: "почтовый"
      }
    });

    expect(mockedCore.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.168.101.3", port: 110, tls: "starttls", authType: "plain" }),
      "ivanov"
    );
  });

  test("без умолчаний ящик создаётся как раньше", async () => {
    mockedDocflow.getSetting.mockResolvedValue(null);

    await request(app.baseUrl, "POST", "/api/accounts", {
      token: TOKEN,
      body: { protocol: "pop3", host: "mail.test", port: 110, tls: "none", authType: "login", username: "x@mail.test", password: "п" }
    });

    expect(mockedCore.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ host: "mail.test", port: 110, tls: "none", authType: "login" }),
      "ivanov"
    );
  });
  /**
   * Вопрос заказчика: умолчания задаются «на сервере в .env или в клиенте у админа»?
   * Ответ — и так, и так: .env засеивает при первом запуске, дальше админ правит их
   * в интерфейсе, и значение в базе важнее переменной окружения (как у каталога).
   */
  test("администратор сохраняет умолчания из интерфейса, и форма их получает", async () => {
    const saved = await request(app.baseUrl, "PUT", "/api/mail-defaults", {
      token: TOKEN_ADMIN,
      body: {
        pop3: { host: "10.0.0.5", port: 110, tls: "starttls", authType: "login" },
        smtp: { host: "10.0.0.6", port: 587, tls: "starttls", authType: "login" }
      }
    });

    expect(saved.status).toBe(200);
    expect(mockedDocflow.setSetting).toHaveBeenCalledWith("mail.defaults", expect.stringContaining("10.0.0.5"));

    mockedDocflow.getSetting.mockResolvedValue(JSON.stringify(saved.body));
    const form = await request(app.baseUrl, "GET", "/api/mail-defaults", { token: TOKEN });
    expect(form.body.pop3.host).toBe("10.0.0.5");
    expect(form.body.smtp.port).toBe(587);
  });

  test("рядовому работнику менять умолчания нечем — 403", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-defaults", {
      token: TOKEN,
      body: { pop3: { host: "10.0.0.5" } }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.setSetting).not.toHaveBeenCalled();
  });

  test("кривой порт и незнакомый раздел отвергаются с понятным текстом", async () => {
    const badPort = await request(app.baseUrl, "PUT", "/api/mail-defaults", {
      token: TOKEN_ADMIN,
      body: { pop3: { host: "10.0.0.5", port: "сто" } }
    });
    expect(badPort.status).toBe(400);
    expect(String(badPort.body.error)).toContain("Порт");

    const badBlock = await request(app.baseUrl, "PUT", "/api/mail-defaults", {
      token: TOKEN_ADMIN,
      body: { pop4: { host: "10.0.0.5" } }
    });
    expect(badBlock.status).toBe(400);
    expect(String(badBlock.body.error)).toContain("Неизвестный раздел");
    expect(mockedDocflow.setSetting).not.toHaveBeenCalled();
  });

  test("пустой объект сбрасывает умолчания предприятия", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-defaults", { token: TOKEN_ADMIN, body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

});
