import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Аккаунты — это доступы к почте. Проверяем шифрование паролей (в базе не должно
 * быть открытого текста), выбор коннектора и пробу подключения.
 */
const mockCreateImap = jest.fn();
const mockPop3 = jest.fn();

jest.mock("../mail/imapConnector.js", () => ({
  __esModule: true,
  createImapConnector: (...a: unknown[]) => mockCreateImap(...a)
}));
jest.mock("../mail/pop3Connector.js", () => ({
  __esModule: true,
  Pop3Connector: function (...a: unknown[]) {
    return mockPop3(...a);
  }
}));

import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { getAccount, listAccounts } from "../repos.js";
import type { AccountInput } from "../types.js";
import {
  buildConnector,
  createAccount,
  decryptPassword,
  decryptSmtpPassword,
  getAccountById,
  getAccounts,
  removeAccount,
  testConnection,
  updateAccountById
} from "./accountService.js";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-accounts-"));
  initApp({ dataDir: dir });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(() => {
  mockCreateImap.mockReset();
  mockPop3.mockReset();
  mockCreateImap.mockReturnValue({ connect: jest.fn(), disconnect: jest.fn() });
  mockPop3.mockReturnValue({ connect: jest.fn(), disconnect: jest.fn() });
});

function input(over: Partial<AccountInput> = {}): AccountInput {
  return {
    protocol: "imap",
    host: "mail.test",
    port: 993,
    tls: "ssl",
    username: "user@mail.test",
    password: "секрет123",
    authType: "login",
    ...over
  };
}

describe("создание аккаунта", () => {
  test("без пароля аккаунт не создаётся", () => {
    expect(() => createAccount(input({ password: "" }))).toThrow(/пароль/i);
  });

  test("пароль хранится зашифрованным и расшифровывается обратно", () => {
    const acc = createAccount(input());
    expect(acc.passwordEncrypted).not.toContain("секрет123");
    expect(decryptPassword(acc)).toBe("секрет123");
  });

  test("отдельный пароль SMTP шифруется, если задан", () => {
    const acc = createAccount(input({ smtpPassword: "smtp-секрет", smtpHost: "smtp.test" }));
    expect(acc.smtpPasswordEncrypted).not.toBeNull();
    expect(decryptSmtpPassword(acc)).toBe("smtp-секрет");
  });

  test("без пароля SMTP используется пароль IMAP", () => {
    const acc = createAccount(input());
    expect(acc.smtpPasswordEncrypted).toBeNull();
    // Иначе отправка молча падала бы с пустым паролем.
    expect(decryptSmtpPassword(acc)).toBe("секрет123");
  });
});

describe("изменение аккаунта", () => {
  test("смена пароля перешифровывает его", () => {
    const acc = createAccount(input());
    const updated = updateAccountById(acc.id, input({ password: "новый-пароль" }))!;
    expect(decryptPassword(updated)).toBe("новый-пароль");
  });

  test("без нового пароля старый сохраняется", () => {
    const acc = createAccount(input());
    const updated = updateAccountById(acc.id, input({ password: "", host: "другой.test" }))!;
    expect(updated.host).toBe("другой.test");
    expect(decryptPassword(updated)).toBe("секрет123");
  });

  /**
   * Жалоба заказчика: «настройки могут сброситься при редактировании почты».
   * Причина — сохранение ЗАМЕНЯЛО объект настроек: частичный payload стирал остальное.
   */
  test("частичное сохранение не стирает прежние настройки", () => {
    const acc = createAccount(
      input({ settings: { signature: "С уважением", signatureHtml: "<p>С уважением</p>", pollIntervalSeconds: 120 } })
    );

    // Клиент прислал только одно поле — остальные обязаны остаться.
    const updated = updateAccountById(acc.id, input({ settings: { displayName: "Петрова М.А." } }))!;

    expect(updated.settings.signature).toBe("С уважением");
    expect(updated.settings.signatureHtml).toBe("<p>С уважением</p>");
    expect(updated.settings.pollIntervalSeconds).toBe(120);
    expect(updated.settings.displayName).toBe("Петрова М.А.");
  });

  test("явно переданное значение перекрывает прежнее", () => {
    const acc = createAccount(input({ settings: { signature: "старая" } }));
    const updated = updateAccountById(acc.id, input({ settings: { signature: "новая" } }))!;
    expect(updated.settings.signature).toBe("новая");
  });

  test("несуществующий аккаунт даёт null", () => {
    expect(updateAccountById("нет-такого", input())).toBeNull();
  });

  test("удаление убирает аккаунт из списка", () => {
    const acc = createAccount(input());
    expect(getAccountById(acc.id)).not.toBeNull();
    removeAccount(acc.id);
    expect(getAccountById(acc.id)).toBeNull();
  });
});

describe("выбор коннектора", () => {
  test("IMAP-аккаунт создаёт IMAP-коннектор", () => {
    const acc = createAccount(input({ protocol: "imap" }));
    buildConnector(acc, "pass");
    expect(mockCreateImap).toHaveBeenCalled();
    expect(mockPop3).not.toHaveBeenCalled();
  });

  test("POP3-аккаунт создаёт POP3-коннектор", () => {
    const acc = createAccount(input({ protocol: "pop3", port: 995 }));
    buildConnector(acc, "pass");
    expect(mockPop3).toHaveBeenCalled();
    expect(mockCreateImap).not.toHaveBeenCalled();
  });

  test("пароль передаётся в коннектор", () => {
    const acc = createAccount(input());
    buildConnector(acc, "переданный-пароль");
    expect(mockCreateImap.mock.calls[0][1]).toBe("переданный-пароль");
  });
});

describe("проверка подключения", () => {
  test("успешное подключение закрывается и возвращает ok", async () => {
    const connect = jest.fn();
    const disconnect = jest.fn();
    mockCreateImap.mockReturnValue({ connect, disconnect });

    const res = await testConnection(input());
    expect(res.ok).toBe(true);
    expect(connect).toHaveBeenCalled();
    // Без disconnect остаётся висящее соединение.
    expect(disconnect).toHaveBeenCalled();
  });

  test("ошибка подключения возвращается текстом, а не исключением", async () => {
    mockCreateImap.mockReturnValue({
      connect: jest.fn(async () => {
        throw new Error("сертификат не принят");
      }),
      disconnect: jest.fn()
    });
    const res = await testConnection(input());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("сертификат");
  });

  test("неверный пароль объясняется по-русски, а не «Command failed»", async () => {
    mockCreateImap.mockReturnValue({
      connect: jest.fn(async () => {
        throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
      }),
      disconnect: jest.fn()
    });
    const res = await testConnection(input());
    expect(res).toEqual({ ok: false, error: "Неправильный логин или пароль" });
  });

  test("без пароля подключение не проверяется", async () => {
    const res = await testConnection(input({ password: "" }));
    expect(res.ok).toBe(false);
    expect(mockCreateImap).not.toHaveBeenCalled();
  });
});

describe("список аккаунтов", () => {
  test("getAccounts возвращает созданные аккаунты", () => {
    const before = getAccounts().length;
    createAccount(input({ username: "list@mail.test" }));
    expect(getAccounts().length).toBe(before + 1);
    expect(listAccounts().some((a) => a.username === "list@mail.test")).toBe(true);
  });
});
