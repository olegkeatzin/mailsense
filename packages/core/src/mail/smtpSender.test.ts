import type { Account } from "../types.js";

/**
 * Отправка проверяется без сети: MIME собирается настоящим nodemailer
 * (streamTransport), а подменяется только транспорт, который лезет в сеть.
 * Так видно, что реально уходит в письме.
 */
const mockSendMail = jest.fn();
const mockClose = jest.fn();
const mockVerify = jest.fn();
const mockTransportOptions: unknown[] = [];

jest.mock("nodemailer", () => {
  const actual = jest.requireActual("nodemailer") as { default?: unknown; createTransport: (o: unknown) => unknown };
  const real = (actual.default ?? actual) as { createTransport: (o: unknown) => unknown };
  return {
    __esModule: true,
    default: {
      ...real,
      createTransport: (opts: Record<string, unknown>) => {
        if (opts && opts.streamTransport) return real.createTransport(opts); // настоящий сборщик MIME
        mockTransportOptions.push(opts);
        return { sendMail: mockSendMail, close: mockClose, verify: mockVerify };
      }
    }
  };
});

import { simpleParser } from "mailparser";
import { buildSmtpTransport, sendSmtp, wrapMessageId } from "./smtpSender.js";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "a1",
    protocol: "imap",
    host: "imap.test",
    port: 993,
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

/** Кириллица в заголовках кодируется по RFC 2047 — раскодируем для проверок. */
function decodeRfc2047(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

beforeEach(() => {
  mockSendMail.mockReset();
  mockClose.mockReset();
  mockVerify.mockReset();
  mockTransportOptions.length = 0;
  mockSendMail.mockResolvedValue({ messageId: "<generated@test>" });
});

describe("обёртка Message-ID", () => {
  test("добавляет угловые скобки", () => {
    expect(wrapMessageId("abc@test")).toBe("<abc@test>");
  });

  test("не удваивает уже обёрнутый идентификатор", () => {
    // Иначе в заголовке окажется <<abc@test>> и почтовики не склеят переписку.
    expect(wrapMessageId("<abc@test>")).toBe("<abc@test>");
  });

  test("пустая строка даёт пустые скобки, а не падение", () => {
    expect(wrapMessageId("")).toBe("<>");
  });
});

describe("параметры SMTP-соединения", () => {
  test("без отдельного SMTP-хоста используется хост IMAP", () => {
    buildSmtpTransport(account(), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ host: "imap.test" });
  });

  test("отдельный SMTP-хост имеет приоритет", () => {
    buildSmtpTransport(account({ smtpHost: "smtp.test" }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ host: "smtp.test" });
  });

  test("порт по умолчанию зависит от шифрования", () => {
    buildSmtpTransport(account({ smtpTls: "starttls" }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ port: 587, secure: false });

    buildSmtpTransport(account({ smtpTls: "ssl" }), "pass");
    expect(mockTransportOptions[1]).toMatchObject({ port: 465, secure: true });
  });

  test("«none» — строго без TLS: апгрейд запрещён", () => {
    // Живая жалоба: сервер предлагал STARTTLS, и письмо уходило по TLS там, где просили
    // открытый текст, — на самоподписанном сертификате это ломалось. ignoreTLS обязателен.
    buildSmtpTransport(account({ smtpTls: "none", smtpPort: 25 }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ secure: false, ignoreTLS: true, requireTLS: false });
  });

  test("«starttls» — требуем шифрование, а не просим", () => {
    buildSmtpTransport(account({ smtpTls: "starttls" }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });

  test("«ssl» — сразу TLS и без принудительного STARTTLS", () => {
    buildSmtpTransport(account({ smtpTls: "ssl" }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ secure: true, ignoreTLS: false, requireTLS: false });
  });

  test("заданный порт перекрывает умолчание", () => {
    buildSmtpTransport(account({ smtpPort: 2525, smtpTls: "ssl" }), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ port: 2525 });
  });

  test("логин SMTP берётся отдельный, иначе от IMAP", () => {
    buildSmtpTransport(account(), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ auth: { user: "user@test.local", pass: "pass" } });

    buildSmtpTransport(account({ smtpUsername: "sender@test.local" }), "smtp-pass");
    expect(mockTransportOptions[1]).toMatchObject({ auth: { user: "sender@test.local", pass: "smtp-pass" } });
  });

  test("строгая проверка сертификата включается настройкой", () => {
    buildSmtpTransport(account(), "pass");
    expect(mockTransportOptions[0]).toMatchObject({ tls: { rejectUnauthorized: false } });

    buildSmtpTransport(account({ settings: { rejectUnauthorized: true } }), "pass");
    expect(mockTransportOptions[1]).toMatchObject({ tls: { rejectUnauthorized: true } });
  });
});

describe("сборка и отправка письма", () => {
  test("собранный MIME читается почтовым парсером", async () => {
    // Проверяем не подстроки, а то, что письмо реально разбирается получателем:
    // кодирование заголовков и тела должно давать исходный текст.
    const { raw } = await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      subject: "Тема письма",
      text: "Текст письма"
    });
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Тема письма");
    expect(parsed.text).toContain("Текст письма");
    expect(parsed.from?.text).toContain("user@test.local");
    expect(parsed.to?.text).toContain("a@test.local");
  });

  test("кириллица в теме кодируется, а не уходит сырым UTF-8", async () => {
    // Сырой UTF-8 в заголовке — нарушение RFC 5322: часть почтовиков покажет мусор.
    const { raw } = await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      subject: "Совещание",
      text: "тело"
    });
    const mime = raw.toString("utf8");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("Subject: Совещание");
    expect(decodeRfc2047(mime)).toContain("Совещание");
  });

  test("Message-ID и ссылки на переписку попадают в заголовки", async () => {
    const { raw } = await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      subject: "Re: тема",
      text: "ответ",
      messageId: "<new@test.local>",
      inReplyTo: "<parent@test.local>",
      references: "<root@test.local> <parent@test.local>"
    });
    const mime = raw.toString("utf8");
    expect(mime).toContain("<new@test.local>");
    expect(mime).toContain("In-Reply-To: <parent@test.local>");
    expect(mime).toContain("<root@test.local>");
  });

  test("вложение доходит до получателя без искажений", async () => {
    const { raw } = await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      subject: "С файлом",
      text: "смотри вложение",
      attachments: [{ filename: "акт.txt", content: Buffer.from("содержимое"), contentType: "text/plain" }]
    });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("акт.txt");
    expect(parsed.attachments[0].content.toString("utf8")).toBe("содержимое");
  });

  test("копия и скрытая копия не теряются", async () => {
    await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      cc: ["cc@test.local"],
      bcc: ["bcc@test.local"],
      subject: "Копии",
      text: "текст"
    });
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.cc).toEqual(["cc@test.local"]);
    expect(mail.bcc).toEqual(["bcc@test.local"]);
  });

  test("возвращается переданный Message-ID", async () => {
    const res = await sendSmtp(account(), "pass", {
      from: "user@test.local",
      to: ["a@test.local"],
      subject: "s",
      text: "t",
      messageId: "<my@test.local>"
    });
    expect(res.messageId).toBe("<my@test.local>");
  });

  test("соединение закрывается после отправки", async () => {
    await sendSmtp(account(), "pass", { from: "u@t", to: ["a@t"], subject: "s", text: "t" });
    expect(mockClose).toHaveBeenCalled();
  });

  test("ошибка отправки закрывает соединение и пробрасывается", async () => {
    mockSendMail.mockRejectedValue(new Error("SMTP отказал"));
    await expect(
      sendSmtp(account(), "pass", { from: "u@t", to: ["a@t"], subject: "s", text: "t" })
    ).rejects.toThrow("SMTP отказал");
    expect(mockClose).toHaveBeenCalled();
  });
});
