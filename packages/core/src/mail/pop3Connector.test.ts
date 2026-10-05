/**
 * Обёртка над POP3-клиентом: настройки соединения, пропуск уже известных писем
 * и корректное закрытие. Сам протокол проверяется в pop3Client.test.ts.
 */
const mockConnect = jest.fn();
const mockLogin = jest.fn();
const mockUidl = jest.fn();
const mockRetrieve = jest.fn();
const mockQuit = jest.fn();
const mockConstructor = jest.fn();

jest.mock("./pop3Client.js", () => ({
  __esModule: true,
  Pop3Client: function (opts: unknown) {
    mockConstructor(opts);
    return { connect: mockConnect, login: mockLogin, uidl: mockUidl, retrieve: mockRetrieve, quit: mockQuit };
  }
}));

import { Pop3Connector } from "./pop3Connector.js";
import type { Account } from "../types.js";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "a1",
    protocol: "pop3",
    host: "pop.test",
    port: 995,
    tls: "ssl",
    username: "user@test.local",
    passwordEncrypted: "",
    authType: "login",
    settings: {},
    smtpHost: null,
    smtpPort: null,
    smtpTls: null,
    smtpUsername: null,
    smtpPasswordEncrypted: null,
    smtpAuthType: null,
    createdAt: "",
    updatedAt: "",
    ...over
  };
}

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockLogin.mockReset().mockResolvedValue(undefined);
  mockUidl.mockReset().mockResolvedValue([]);
  mockRetrieve.mockReset().mockResolvedValue(Buffer.from("письмо"));
  mockQuit.mockReset().mockResolvedValue(undefined);
  mockConstructor.mockReset();
});

describe("подключение", () => {
  test("параметры берутся из аккаунта", async () => {
    await new Pop3Connector(account(), "пароль").connect();
    expect(mockConstructor).toHaveBeenCalledWith({
      host: "pop.test",
      port: 995,
      tls: "ssl",
      username: "user@test.local",
      password: "пароль",
      rejectUnauthorized: false
    });
  });

  test("строгая проверка сертификата включается настройкой", async () => {
    await new Pop3Connector(account({ settings: { rejectUnauthorized: true } }), "пароль").connect();
    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ rejectUnauthorized: true }));
  });

  test("таймаут чтения берётся из настроек аккаунта", async () => {
    // Без этого «замолчавший» сервер держит скан 30 секунд по умолчанию, и
    // настройку нельзя ни ускорить, ни задать под конкретный сервер.
    await new Pop3Connector(account({ settings: { timeoutMs: 1234 } }), "пароль").connect();
    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1234 }));
  });

  test("некорректный таймаут игнорируется, клиент берёт свой", async () => {
    await new Pop3Connector(account({ settings: { timeoutMs: -5 } }), "пароль").connect();
    expect(mockConstructor.mock.calls[0][0].timeoutMs).toBeUndefined();
    await new Pop3Connector(account({ settings: { timeoutMs: "30s" } }), "пароль").connect();
    expect(mockConstructor.mock.calls[1][0].timeoutMs).toBeUndefined();
  });

  test("сначала подключение, потом вход", async () => {
    const order: string[] = [];
    mockConnect.mockImplementation(async () => void order.push("connect"));
    mockLogin.mockImplementation(async () => void order.push("login"));

    await new Pop3Connector(account(), "пароль").connect();
    // Вход до подключения невозможен — сервер ещё не отвечает.
    expect(order).toEqual(["connect", "login"]);
  });

  test("ошибка подключения пробрасывается", async () => {
    mockConnect.mockRejectedValue(new Error("сервер недоступен"));
    await expect(new Pop3Connector(account(), "пароль").connect()).rejects.toThrow("сервер недоступен");
  });

  test("ошибка входа пробрасывается", async () => {
    mockLogin.mockRejectedValue(new Error("неверный логин/пароль"));
    await expect(new Pop3Connector(account(), "пароль").connect()).rejects.toThrow(/неверный/);
  });
});

describe("получение писем", () => {
  test("без подключения — понятная ошибка", async () => {
    await expect(new Pop3Connector(account(), "пароль").fetchNew("INBOX", new Set())).rejects.toThrow(
      /не подключён/
    );
  });

  test("уже известные письма не скачиваются", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    mockUidl.mockResolvedValue([
      { num: 1, uid: "known" },
      { num: 2, uid: "new" }
    ]);
    mockRetrieve.mockResolvedValue(Buffer.from("новое письмо"));

    const out = await c.fetchNew("INBOX", new Set(["known"]));

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ uid: "new", source: Buffer.from("новое письмо") });
    // Скачивать известное письмо — лишний трафик и время.
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockRetrieve).toHaveBeenCalledWith(2);
  });

  test("пустой ящик даёт пустой список", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    mockUidl.mockResolvedValue([]);
    expect(await c.fetchNew("INBOX", new Set())).toEqual([]);
  });

  test("все письма известны — ничего не скачивается", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    mockUidl.mockResolvedValue([{ num: 1, uid: "a" }]);
    expect(await c.fetchNew("INBOX", new Set(["a"]))).toEqual([]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test("порядок писем сохраняется", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    mockUidl.mockResolvedValue([
      { num: 3, uid: "third" },
      { num: 1, uid: "first" },
      { num: 2, uid: "second" }
    ]);
    const out = await c.fetchNew("INBOX", new Set());
    expect(out.map((m) => m.uid)).toEqual(["third", "first", "second"]);
  });
});

describe("завершение", () => {
  test("соединение закрывается штатно", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    await c.disconnect();
    expect(mockQuit).toHaveBeenCalled();
  });

  test("повторное закрытие ничего не делает", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    await c.disconnect();
    await c.disconnect();
    // Второй quit по уже закрытому соединению — ошибка протокола.
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  test("закрытие без подключения не падает", async () => {
    await expect(new Pop3Connector(account(), "пароль").disconnect()).resolves.toBeUndefined();
  });

  test("после закрытия скачивание недоступно", async () => {
    const c = new Pop3Connector(account(), "пароль");
    await c.connect();
    await c.disconnect();
    await expect(c.fetchNew("INBOX", new Set())).rejects.toThrow(/не подключён/);
  });
});
