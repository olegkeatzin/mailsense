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
import { getEmail, listAttachments, listEmails } from "../repos.js";
import { createAccount } from "./accountService.js";
import { ComposeInputError, sendEmail, testSmtpConnection } from "./sendService.js";
import { logger } from "../logger.js";
import * as attachmentStore from "../attachments/store.js";
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

  test("fromName работника перекрывает имя ящика, адрес остаётся адресом ящика", async () => {
    const shared = createAccount({
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      username: "shared-box@mail.test",
      password: "пароль",
      authType: "login",
      settings: { displayName: "Аппарат генерального директора" }
    });
    await sendEmail(compose({ accountId: shared.id, fromName: "Сидорова А.А." }));
    // Письмо уходит с общего ящика, но подписано именем работника.
    expect(mockSendSmtp.mock.calls[0][2].from).toBe('"Сидорова А.А." <shared-box@mail.test>');
  });

  test("fromName не подменяет адрес: адрес всегда ящика аккаунта", async () => {
    await sendEmail(compose({ fromName: "ivanov@mail.test" }));
    expect(mockSendSmtp.mock.calls[0][2].from).toBe('"ivanov@mail.test" <user@mail.test>');
  });

  test("пустой fromName = поле не задано, поведение прежнее", async () => {
    const named2 = createAccount({
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      username: "named2@mail.test",
      password: "пароль",
      authType: "login",
      settings: { displayName: "Петров П.П." }
    });
    await sendEmail(compose({ accountId: named2.id, fromName: "   " }));
    expect(mockSendSmtp.mock.calls[0][2].from).toBe('"Петров П.П." <named2@mail.test>');
  });

  test("перевод строки в fromName — отказ, а не тихая чистка", async () => {
    await expect(sendEmail(compose({ fromName: "Сидорова А.А.\r\nBcc: evil@test.local" }))).rejects.toThrow(
      ComposeInputError
    );
    expect(mockSendSmtp).not.toHaveBeenCalled();
  });

  test("кавычка в fromName ломает заголовок — отказ", async () => {
    await expect(sendEmail(compose({ fromName: 'ООО "Ромашка"' }))).rejects.toThrow(ComposeInputError);
    expect(mockSendSmtp).not.toHaveBeenCalled();
  });

  test("слишком длинный fromName (больше 120) — отказ", async () => {
    await expect(sendEmail(compose({ fromName: "я".repeat(121) }))).rejects.toThrow(ComposeInputError);
    expect(mockSendSmtp).not.toHaveBeenCalled();
  });

  test("replyTo попадает в заголовок Reply-To", async () => {
    await sendEmail(compose({ replyTo: "  replies@test.local " }));
    expect(mockSendSmtp.mock.calls[0][2].replyTo).toBe("replies@test.local");
  });

  test("мусор в replyTo — отказ", async () => {
    for (const bad of ["не адрес", "a@b", "a b@test.local", "@test.local", "a@test.local, b@test.local", "a@test.local\r\nBcc: x@y.z"]) {
      mockSendSmtp.mockClear();
      await expect(sendEmail(compose({ replyTo: bad }))).rejects.toThrow(ComposeInputError);
      expect(mockSendSmtp).not.toHaveBeenCalled();
    }
  });

  test("пустой replyTo = поле не задано", async () => {
    await sendEmail(compose({ replyTo: "" }));
    expect(mockSendSmtp.mock.calls[0][2].replyTo).toBeUndefined();
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

describe("копия в «Отправленных» хранит вложения", () => {
  const attachment = (filename: string, content: Buffer) => ({
    filename,
    mimeType: "application/pdf",
    data: content.toString("base64")
  });

  test("два вложения с одинаковым именем не затирают друг друга, байты совпадают", async () => {
    const first = Buffer.from("первый файл: содержимое А", "utf8");
    const second = Buffer.from("второй файл: содержимое Б", "utf8");

    const res = await sendEmail(
      compose({
        attachments: [attachment("Договор (копия).pdf", first), attachment("Договор (копия).pdf", second)]
      })
    );

    const saved = listAttachments(res.emailId);
    // Раньше строк вложений у отправленного письма не было вовсе: человек открывал
    // «Отправленные» и не видел файлов, которые ушли адресату.
    expect(saved.map((a) => a.filename)).toEqual(["Договор (копия).pdf", "Договор (копия).pdf"]);
    expect(saved.map((a) => a.size)).toEqual([first.length, second.length]);

    // ⚠️ Имя не уникально: файлы на диске обязаны быть разными, а содержимое — ровно
    // тем, что ушло в письме.
    expect(new Set(saved.map((a) => a.storagePath)).size).toBe(2);
    const onDisk = saved.map((a) => fs.readFileSync(a.storagePath as string).toString("utf8")).sort();
    expect(onDisk).toEqual([first.toString("utf8"), second.toString("utf8")].sort());
  });

  test("вид вложения определяется по типу, содержимое не извлекается", async () => {
    const res = await sendEmail(compose({ attachments: [attachment("акт.pdf", Buffer.from("%PDF-1.4 тест"))] }));

    const att = listAttachments(res.emailId)[0];
    expect(att.kind).toBe("pdf");
    expect(att.handled).toBe(true);
    // Отправителю незачем извлекать текст из собственного вложения (и звать OCR).
    expect(att.extractedText).toBeNull();
  });

  test("сбой сохранения вложения не превращает удачную отправку в ошибку", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    const saveSpy = jest.spyOn(attachmentStore, "saveAttachmentFile").mockImplementation(() => {
      throw new Error("нет места на диске");
    });

    try {
      const res = await sendEmail(compose({ attachments: [attachment("акт.pdf", Buffer.from("данные"))] }));

      // Письмо адресату уже ушло — падать после этого нельзя.
      expect(res.messageId).toBeTruthy();
      expect(listAttachments(res.emailId)).toEqual([]);
      // Но и молчать нельзя: причина видна в логе.
      const logged = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join(" ");
      expect(logged).toContain("нет места на диске");
      expect(logged).toContain("Отправленных");
    } finally {
      saveSpy.mockRestore();
      warnSpy.mockRestore();
    }
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
