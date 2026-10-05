import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Отправка письма: сборка заголовков, сохранение копии в «Отправленные»
 * и раскладка вложения в IMAP. Сам SMTP и коннекторы подменены — сети нет.
 */
const mockSendSmtp = jest.fn();
const mockBuildTransport = jest.fn();
const mockCreateImap = jest.fn();
const mockPop3 = jest.fn();

jest.mock("../mail/smtpSender.js", () => {
  const actual = jest.requireActual("../mail/smtpSender.js") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    sendSmtp: (...a: unknown[]) => mockSendSmtp(...a),
    buildSmtpTransport: (...a: unknown[]) => mockBuildTransport(...a)
  };
});
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
import { getEmail, listEmails } from "../repos.js";
import { createAccount } from "./accountService.js";
import { sendEmail, testSmtpConnection } from "./sendService.js";
import type { ComposeInput } from "../types.js";

let dir = "";
let accountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-send-"));
  initApp({ dataDir: dir });
  accountId = createAccount({
    protocol: "imap",
    host: "mail.test",
    port: 993,
    tls: "ssl",
    username: "user@mail.test",
    password: "пароль",
    authType: "login"
  }).id;
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

let appendRaw: jest.Mock;
let connect: jest.Mock;
let disconnect: jest.Mock;

beforeEach(() => {
  mockSendSmtp.mockReset();
  mockBuildTransport.mockReset();
  mockCreateImap.mockReset();
  mockPop3.mockReset();
  appendRaw = jest.fn();
  connect = jest.fn();
  disconnect = jest.fn();
  mockCreateImap.mockReturnValue({ connect, disconnect, appendRaw });
  mockPop3.mockReturnValue({ connect, disconnect });
  mockSendSmtp.mockResolvedValue({ messageId: "<generated@test>", raw: Buffer.from("MIME-письмо") });
});

function compose(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    accountId,
    to: [{ address: "client@test.local" }],
    subject: "Тема",
    bodyText: "Текст письма",
    ...over
  };
}

describe("отправка", () => {
  test("несуществующий аккаунт — понятная ошибка", async () => {
    await expect(sendEmail(compose({ accountId: "нет-такого" }))).rejects.toThrow(/Аккаунт не найден/);
  });

  test("без получателя письмо не уходит", async () => {
    await expect(sendEmail(compose({ to: [] }))).rejects.toThrow(/получател/i);
    expect(mockSendSmtp).not.toHaveBeenCalled();
  });

  test("адрес с именем оформляется по правилам заголовков", async () => {
    await sendEmail(compose({ to: [{ name: "Иванов И.И.", address: "ivanov@test.local" }] }));
    const opts = mockSendSmtp.mock.calls[0][2];
    expect(opts.to[0]).toBe('"Иванов И.И." <ivanov@test.local>');
  });

  test("кавычка в имени экранируется, а не рвёт заголовок", async () => {
    await sendEmail(compose({ to: [{ name: 'ООО "Ромашка"', address: "a@test.local" }] }));
    expect(mockSendSmtp.mock.calls[0][2].to[0]).toBe('"ООО \\"Ромашка\\"" <a@test.local>');
  });

  test("отображаемое имя аккаунта попадает в «От кого»", async () => {
    const named = createAccount({
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      username: "named@mail.test",
      password: "пароль",
      authType: "login",
      settings: { displayName: "Петров П.П." }
    });
    await sendEmail(compose({ accountId: named.id }));
    expect(mockSendSmtp.mock.calls[0][2].from).toBe('"Петров П.П." <named@mail.test>');
  });

  test("без отображаемого имени используется голый адрес", async () => {
    await sendEmail(compose());
    expect(mockSendSmtp.mock.calls[0][2].from).toBe("user@mail.test");
  });

  test("ссылки переписки оборачиваются в угловые скобки", async () => {
    await sendEmail(
      compose({
        inReplyToMessageId: "parent@test.local",
        references: ["root@test.local", "parent@test.local"]
      })
    );
    const opts = mockSendSmtp.mock.calls[0][2];
    expect(opts.inReplyTo).toBe("<parent@test.local>");
    expect(opts.references).toBe("<root@test.local> <parent@test.local>");
  });

  test("вложение раскодируется из base64", async () => {
    await sendEmail(
      compose({
        attachments: [{ filename: "акт.txt", mimeType: "text/plain", data: Buffer.from("содержимое").toString("base64") }]
      })
    );
    const att = mockSendSmtp.mock.calls[0][2].attachments[0];
    expect(att.filename).toBe("акт.txt");
    expect(att.contentType).toBe("text/plain");
    expect(att.content.toString("utf8")).toBe("содержимое");
  });
});

describe("сохранение копии", () => {
  test("письмо появляется в «Отправленных» уже готовым", async () => {
    const res = await sendEmail(compose({ subject: "Сохранённое" }));
    const saved = getEmail(res.emailId)!;
    expect(saved.folder).toBe("Sent");
    expect(saved.subject).toBe("Сохранённое");
    // Копия не требует анализа — она уже отправлена пользователем.
    expect(saved.analysisStatus).toBe("ready");
  });

  test("в базе Message-ID хранится без угловых скобок", async () => {
    const res = await sendEmail(compose());
    expect(res.messageId).not.toContain("<");
    expect(getEmail(res.emailId)!.messageId).toBe(res.messageId);
  });

  test("в заголовок уходит обёрнутый Message-ID", async () => {
    const res = await sendEmail(compose());
    expect(mockSendSmtp.mock.calls[0][2].messageId).toBe("<" + res.messageId + ">");
  });

  test("ответ сохраняет связь с исходным письмом", async () => {
    const res = await sendEmail(compose({ inReplyToMessageId: "parent@test.local" }));
    expect(getEmail(res.emailId)!.inReplyTo).toBe("parent@test.local");
  });

  test("копия дописывается в папку IMAP", async () => {
    await sendEmail(compose());
    expect(connect).toHaveBeenCalled();
    expect(appendRaw).toHaveBeenCalledWith("Sent", expect.any(Buffer), ["\\Seen"]);
    expect(disconnect).toHaveBeenCalled();
  });

  test("своя папка «Отправленные» из настроек используется", async () => {
    const custom = createAccount({
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      username: "custom@mail.test",
      password: "пароль",
      authType: "login",
      settings: { sentFolder: "Отправленные" }
    });
    await sendEmail(compose({ accountId: custom.id }));
    expect(appendRaw).toHaveBeenCalledWith("Отправленные", expect.any(Buffer), ["\\Seen"]);
  });

  test("для POP3 копия в IMAP не дописывается", async () => {
    const pop3 = createAccount({
      protocol: "pop3",
      host: "mail.test",
      port: 995,
      tls: "ssl",
      username: "pop3@mail.test",
      password: "пароль",
      authType: "login"
    });
    await sendEmail(compose({ accountId: pop3.id }));
    // У POP3 нет папок — попытка дописать копию была бы ошибкой.
    expect(appendRaw).not.toHaveBeenCalled();
  });

  test("сбой копии не превращает удачную отправку в ошибку", async () => {
    appendRaw.mockRejectedValue(new Error("папка недоступна"));
    // Письмо получателю уже ушло: пользователь не должен увидеть «ошибка».
    await expect(sendEmail(compose())).resolves.toMatchObject({ messageId: expect.any(String) });
    expect(listEmails({ accountId }).some((e) => e.folder === "Sent")).toBe(true);
  });
});

describe("проверка SMTP", () => {
  test("несуществующий аккаунт", async () => {
    const res = await testSmtpConnection("нет-такого");
    expect(res.ok).toBe(false);
  });

  test("успешная проверка закрывает соединение", async () => {
    const verify = jest.fn();
    const close = jest.fn();
    mockBuildTransport.mockReturnValue({ verify, close });

    const res = await testSmtpConnection(accountId);
    expect(res.ok).toBe(true);
    expect(verify).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  test("ошибка проверки возвращается текстом", async () => {
    mockBuildTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw new Error("логин отклонён");
      }),
      close: jest.fn()
    });
    const res = await testSmtpConnection(accountId);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("логин отклонён");
  });
});
