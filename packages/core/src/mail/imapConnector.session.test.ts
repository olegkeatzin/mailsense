/**
 * Соединение, папки и копии. Выборка писем проверяется в imapConnector.test.ts
 * (там подставной клиент), здесь — то, что требует настоящего конструктора ImapFlow.
 */
const mockConnect = jest.fn();
const mockSearch = jest.fn();
const mockFetch = jest.fn();
const mockGetMailboxLock = jest.fn();
const mockList = jest.fn();
const mockAppend = jest.fn();
const mockLogout = jest.fn();
const mockConstructor = jest.fn();

jest.mock("imapflow", () => ({
  __esModule: true,
  ImapFlow: function (opts: unknown) {
    mockConstructor(opts);
    return {
      connect: mockConnect,
      search: mockSearch,
      fetch: mockFetch,
      getMailboxLock: mockGetMailboxLock,
      list: mockList,
      append: mockAppend,
      logout: mockLogout
    };
  }
}));

import { createImapConnector, ImapConnector } from "./imapConnector.js";
import type { Account } from "../types.js";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "a1", protocol: "imap", host: "imap.test", port: 993, tls: "ssl",
    username: "user@test.local", passwordEncrypted: "", authType: "login", settings: {},
    smtpHost: null, smtpPort: null, smtpTls: null, smtpUsername: null,
    smtpPasswordEncrypted: null, smtpAuthType: null, createdAt: "", updatedAt: "",
    ...over
  };
}

/** imapflow.fetch используется через for await — нужен асинхронный итератор. */
function asyncIter<T>(items: T[]): AsyncGenerator<T> {
  return (async function* () {
    for (const i of items) yield i;
  })();
}

let release: jest.Mock;

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockSearch.mockReset().mockResolvedValue([]);
  mockFetch.mockReset().mockImplementation(() => asyncIter([]));
  release = jest.fn();
  mockGetMailboxLock.mockReset().mockResolvedValue({ release });
  mockList.mockReset().mockResolvedValue([]);
  mockAppend.mockReset().mockResolvedValue(undefined);
  mockLogout.mockReset().mockResolvedValue(undefined);
  mockConstructor.mockReset();
});

describe("подключение", () => {
  test("пароль берётся расшифрованный, а не из аккаунта", async () => {
    await createImapConnector(account(), "расшифрованный").connect();
    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "user@test.local", pass: "расшифрованный" } })
    );
  });

  test("TLS включается только для ssl", async () => {
    await createImapConnector(account({ tls: "starttls" }), "p").connect();
    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ secure: false }));
    await createImapConnector(account({ tls: "ssl" }), "p").connect();
    expect(mockConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ secure: true }));
  });

  test("строгая проверка сертификата включается настройкой", async () => {
    await createImapConnector(account({ settings: { rejectUnauthorized: true } }), "p").connect();
    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ tls: { rejectUnauthorized: true } }));
  });

  test("собственный лог imapflow выключен", async () => {
    await createImapConnector(account(), "p").connect();
    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ logger: false }));
  });

  test("ошибка подключения пробрасывается", async () => {
    mockConnect.mockRejectedValue(new Error("сертификат отклонён"));
    await expect(createImapConnector(account(), "p").connect()).rejects.toThrow("сертификат отклонён");
  });
});

describe("папка ящика", () => {
  test("пустое имя папки означает INBOX", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    await c.fetchNew("", new Set());
    expect(mockGetMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  test("папка освобождается даже при ошибке", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    mockSearch.mockRejectedValue(new Error("сервер упал"));
    mockFetch.mockImplementation(() => {
      throw new Error("и здесь упал");
    });

    await expect(c.fetchNew("Работа", new Set())).rejects.toBeTruthy();
    // Незакрытая папка блокирует все последующие операции с ящиком.
    expect(release).toHaveBeenCalled();
  });

  test("письма без тела пропускаются", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    mockSearch.mockResolvedValue([1, 2]);
    mockFetch.mockImplementation(() => asyncIter([{ uid: 1, source: null }, { uid: 2, source: Buffer.from("тело") }]));

    const out = await c.fetchNew("INBOX", new Set());
    expect(out.map((m) => m.uid)).toEqual(["2"]);
  });

  test("неожиданный ответ поиска ведёт к фолбэку на весь ящик", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    mockSearch.mockResolvedValue(undefined);
    mockFetch.mockImplementation(() => asyncIter([{ uid: 9, source: Buffer.from("x") }]));

    await c.fetchNew("INBOX", new Set());
    expect(mockFetch.mock.calls[0][0]).toBe("1:*");
  });
});

describe("список папок", () => {
  test("папки отображаются в общий формат", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    mockList.mockResolvedValue([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
      { path: "Работа", name: "Работа" },
      { path: "Прочее", name: "Прочее", specialUse: 42 }
    ]);

    const list = await c.listMailboxes();
    expect(list[0]).toEqual({ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
    // Нестроковый specialUse не должен просачиваться наружу.
    expect(list[1].specialUse).toBeUndefined();
    expect(list[2].specialUse).toBeUndefined();
  });

  test("без подключения список недоступен", async () => {
    await expect(new ImapConnector(account()).listMailboxes()).rejects.toThrow(/не подключён/);
  });
});

describe("копия письма", () => {
  test("по умолчанию копия помечается прочитанной", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    const raw = Buffer.from("MIME");
    await c.appendRaw("Sent", raw);
    expect(mockAppend).toHaveBeenCalledWith("Sent", raw, ["\\Seen"], expect.any(Date));
  });

  test("заданные флаги не перекрываются", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    await c.appendRaw("Drafts", Buffer.from("x"), ["\\Draft"]);
    expect(mockAppend.mock.calls[0][2]).toEqual(["\\Draft"]);
  });

  test("без подключения копирование невозможно", async () => {
    await expect(new ImapConnector(account()).appendRaw("Sent", Buffer.from("x"))).rejects.toThrow(/не подключён/);
  });
});

describe("завершение", () => {
  test("соединение закрывается штатно", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    await c.disconnect();
    expect(mockLogout).toHaveBeenCalled();
  });

  test("ошибка выхода не выбрасывается наружу", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    mockLogout.mockRejectedValue(new Error("соединение уже закрыто"));
    await expect(c.disconnect()).resolves.toBeUndefined();
  });

  test("повторное закрытие ничего не делает", async () => {
    const c = createImapConnector(account(), "p");
    await c.connect();
    await c.disconnect();
    await c.disconnect();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  test("закрытие без подключения не падает", async () => {
    await expect(new ImapConnector(account()).disconnect()).resolves.toBeUndefined();
  });
});
