import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * mailService — сборка писем из ящика и из файлов. Проверяем на подменённом
 * коннекторе: сеть здесь не нужна, а вот дедупликация, диапазон дат, надгробия
 * и сериализация сканов — поведение, которое ломается незаметно.
 */
const mockBuildConnector = jest.fn();
const mockEnqueue = jest.fn();

jest.mock("./accountService.js", () => ({
  __esModule: true,
  buildConnector: (...args: unknown[]) => mockBuildConnector(...args),
  decryptPassword: () => "расшифрованный-пароль"
}));

jest.mock("./analysisService.js", () => ({
  __esModule: true,
  enqueue: (...args: unknown[]) => mockEnqueue(...args)
}));

// pdfjs-dist — ESM и в jest не грузится: разбор PDF подменяем, как в
// attachments/index.test.ts. Вложение при этом проходит весь остальной путь.
jest.mock("../attachments/pdf.js", () => ({
  __esModule: true,
  pdfToImages: async () => ({ pages: [], totalPages: 0, truncated: false }),
  pdfToText: async () => "",
  pdfPageToImage: async () => null
}));

import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import { deleteEmails, getAccount, listAccounts, listAttachments, listEmails, setSetting } from "../repos.js";
import { Pop3Connector } from "../mail/pop3Connector.js";
import { getDb } from "../db/index.js";
import { emails } from "../db/schema.js";
import { normalizeMessageId } from "../mail/parser.js";
import { fetchEmails, importEmails, isFetching } from "./mailService.js";
import type { MailConnector, RawMessage } from "../mail/connector.js";

let dir = "";
let accountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-mailservice-"));
  initApp({
    dataDir: dir,
    seedAccount: true,
    defaultAccount: {
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      username: "user@mail.test",
      password: "secret",
      authType: "login"
    }
  });
  accountId = listAccounts()[0].id;
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
  mockBuildConnector.mockReset();
  mockEnqueue.mockReset();
  setSetting("auto_analyze", "false"); // иначе тест уйдёт в реальный анализ
});

function rawEmail(over: { messageId?: string | null; subject?: string; date?: string; body?: string } = {}): Buffer {
  const id = over.messageId === undefined ? "<" + randomUUID() + "@test.local>" : over.messageId;
  const lines = [
    "From: sender@test.local",
    "To: receiver@test.local",
    "Subject: " + (over.subject ?? "Тема письма"),
    "Date: " + (over.date ?? "Wed, 15 Jan 2026 10:00:00 +0300"),
    ...(id ? ["Message-ID: " + id] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    over.body ?? "Текст письма"
  ];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

interface FakeOptions {
  messages?: RawMessage[];
  mailboxes?: Array<{ path: string; name: string; specialUse?: string }>;
  fetchError?: Error;
  disconnectError?: Error;
}

function fakeConnector(opts: FakeOptions = {}) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const connector = {
    connect: jest.fn(async () => {
      calls.push("connect");
    }),
    disconnect: jest.fn(async () => {
      calls.push("disconnect");
      if (opts.disconnectError) throw opts.disconnectError;
    }),
    listMailboxes: jest.fn(async () => opts.mailboxes ?? []),
    fetchNew: jest.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (opts.fetchError) throw opts.fetchError;
      return opts.messages ?? [];
    })
  };
  return { connector: connector as unknown as MailConnector, calls, stats: () => ({ maxActive }) };
}

describe("получение писем из ящика", () => {
  test("письмо сохраняется, счётчик добавленных растёт", async () => {
    const { connector, calls } = fakeConnector({ messages: [{ uid: "1", source: rawEmail({ subject: "Первое" }) }] });
    mockBuildConnector.mockReturnValue(connector);

    const res = await fetchEmails(accountId);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(0);
    expect(calls).toEqual(["connect", "disconnect"]);
  });

  test("повторное скачивание того же письма пропускается по Message-ID", async () => {
    const source = rawEmail({ messageId: "<dup@test.local>" });
    const first = fakeConnector({ messages: [{ uid: "10", source }] });
    mockBuildConnector.mockReturnValue(first.connector);
    expect((await fetchEmails(accountId)).added).toBe(1);

    const second = fakeConnector({ messages: [{ uid: "11", source }] });
    mockBuildConnector.mockReturnValue(second.connector);
    const res = await fetchEmails(accountId);
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
  });

  test("известные UID передаются коннектору — иначе ящик качается целиком", async () => {
    const { connector } = fakeConnector({ messages: [] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    expect(connector.fetchNew).toHaveBeenCalledWith("INBOX", expect.any(Set), expect.anything());
  });

  test("письмо вне диапазона дат пропускается", async () => {
    const { connector } = fakeConnector({
      messages: [{ uid: "20", source: rawEmail({ date: "Mon, 01 Jan 2024 10:00:00 +0300" }) }]
    });
    mockBuildConnector.mockReturnValue(connector);

    const res = await fetchEmails(accountId, { since: "2026-01-01", until: "2026-12-31" });
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
  });

  test("письмо внутри диапазона сохраняется", async () => {
    const { connector } = fakeConnector({
      messages: [{ uid: "21", source: rawEmail({ date: "Wed, 15 Jan 2026 10:00:00 +0300" }) }]
    });
    mockBuildConnector.mockReturnValue(connector);
    expect((await fetchEmails(accountId, { since: "2026-01-01", until: "2026-12-31" })).added).toBe(1);
  });

  test("сломанное письмо не роняет скан целиком", async () => {
    const { connector } = fakeConnector({
      messages: [
        { uid: "30", source: Buffer.from("не письмо вовсе") },
        { uid: "31", source: rawEmail({ subject: "Целое" }) }
      ]
    });
    mockBuildConnector.mockReturnValue(connector);
    const res = await fetchEmails(accountId);
    expect(res.added + res.skipped).toBe(2);
  });

  test("отметка последней синхронизации сохраняется", async () => {
    const { connector } = fakeConnector({ messages: [] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    expect(getAccount(accountId)!.settings.lastFetchAt).toBeTruthy();
  });

  test("ошибка коннектора всё равно закрывает соединение", async () => {
    const { connector, calls } = fakeConnector({ fetchError: new Error("сеть упала") });
    mockBuildConnector.mockReturnValue(connector);
    await expect(fetchEmails(accountId)).rejects.toThrow("сеть упала");
    expect(calls).toContain("disconnect");
  });

  test("ошибка отключения не подменяет причину сбоя скана", async () => {
    // Иначе в журнале и в интерфейсе видно «не удалось закрыть соединение»
    // вместо настоящей причины — диагностика врёт.
    const { connector, calls } = fakeConnector({
      fetchError: new Error("сеть упала"),
      disconnectError: new Error("сокет уже закрыт")
    });
    mockBuildConnector.mockReturnValue(connector);

    await expect(fetchEmails(accountId)).rejects.toThrow("сеть упала");
    expect(calls).toContain("disconnect");
  });

  test("ошибка отключения не превращает удачный скан в сбой", async () => {
    // Письма уже сохранены — терять результат из-за неудачного QUIT нельзя.
    const { connector } = fakeConnector({ messages: [], disconnectError: new Error("нет связи") });
    mockBuildConnector.mockReturnValue(connector);
    await expect(fetchEmails(accountId)).resolves.toEqual({ added: 0, skipped: 0 });
  });
});

/** «Замолчавший» POP3-сервер: соединение принимается, ответа нет. */
function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    // Ни одного байта в ответ — именно так выглядит зависший POP3-сервер.
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            srv.close(() => r());
          })
      });
    });
  });
}

describe("зависший POP3-сервер", () => {
  test("молчащий сервер завершает скан ошибкой, аккаунт не залипает", async () => {
    const srv = await silentServer();
    // Настоящий коннектор и настоящий сокет: проверяем всю цепочку до сервиса.
    const account = {
      ...getAccount(accountId)!,
      protocol: "pop3" as const,
      host: "127.0.0.1",
      port: srv.port,
      tls: "none" as const,
      settings: { timeoutMs: 200 }
    };
    mockBuildConnector.mockReturnValue(new Pop3Connector(account, "secret"));
    try {
      await expect(fetchEmails(accountId)).rejects.toThrow(/не отвечает/);
      // Главное: аккаунт не остался «в процессе». Иначе кнопка «Скан» и
      // планировщик молчат до перезапуска приложения.
      expect(isFetching(accountId)).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

describe("папка «Отправленные»", () => {
  const sentMailbox = { path: "Sent", name: "Sent", specialUse: "\\Sent" };

  test("берётся из SPECIAL-USE, а не по имени", async () => {
    const { connector } = fakeConnector({ messages: [], mailboxes: [sentMailbox] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    const folders = (connector.fetchNew as jest.Mock).mock.calls.map((c) => c[0]);
    expect(folders).toContain("Sent");
  });

  test("не синхронизируется, если её нет", async () => {
    const { connector } = fakeConnector({ messages: [], mailboxes: [] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    expect((connector.fetchNew as jest.Mock).mock.calls.map((c) => c[0])).toEqual(["INBOX"]);
  });
});

describe("надгробия удалённых писем", () => {
  /** Ищем напрямую в базе: listEmails отдаёт ограниченную выборку. */
  function idByMessageId(messageId: string): string | undefined {
    // В базе Message-ID хранится нормализованным — без угловых скобок.
    const key = normalizeMessageId(messageId);
    return getDb().select({ id: emails.id }).from(emails).where(eq(emails.messageId, key)).get()?.id;
  }

  /** Удаляет письмо штатным путём — так создаётся настоящее надгробие. */
  function deleteByMessageId(messageId: string): number {
    const id = idByMessageId(messageId);
    return id ? deleteEmails([id]) : 0;
  }

  test("удаление письма создаёт надгробие", async () => {
    const source = rawEmail({ messageId: "<tombstone@test.local>" });
    mockBuildConnector.mockReturnValue(fakeConnector({ messages: [{ uid: "40", source }] }).connector);
    await fetchEmails(accountId);
    expect(deleteByMessageId("<tombstone@test.local>")).toBe(1);
  });

  test("обычный скан не воскрешает удалённое письмо", async () => {
    const source = rawEmail({ messageId: "<deleted@test.local>" });
    mockBuildConnector.mockReturnValue(fakeConnector({ messages: [{ uid: "42", source }] }).connector);
    await fetchEmails(accountId);
    deleteByMessageId("<deleted@test.local>");

    mockBuildConnector.mockReturnValue(fakeConnector({ messages: [{ uid: "42", source }] }).connector);
    expect((await fetchEmails(accountId)).added).toBe(0);
  });

  test("ручной скан (includeDeleted) возвращает удалённое письмо", async () => {
    const source = rawEmail({ messageId: "<restore@test.local>" });
    mockBuildConnector.mockReturnValue(fakeConnector({ messages: [{ uid: "41", source }] }).connector);
    await fetchEmails(accountId);
    deleteByMessageId("<restore@test.local>");
    expect(idByMessageId("<restore@test.local>")).toBeUndefined();

    mockBuildConnector.mockReturnValue(fakeConnector({ messages: [{ uid: "41", source }] }).connector);
    const res = await fetchEmails(accountId, { includeDeleted: true });

    // Без includeDeleted письмо не вернулось бы никогда — надгробие блокирует повторный скан.
    expect(res.added).toBe(1);
    expect(idByMessageId("<restore@test.local>")).toBeTruthy();
  });
});

describe("сериализация сканов", () => {
  test("два одновременных скана одного аккаунта не идут параллельно", async () => {
    const { connector, stats } = fakeConnector({ messages: [] });
    mockBuildConnector.mockReturnValue(connector);

    await Promise.all([fetchEmails(accountId), fetchEmails(accountId)]);
    // Иначе IMAP отвечает «Connection not available» и скан падает по таймауту.
    expect(stats().maxActive).toBe(1);
  });

  test("признак активного скана снимается после завершения", async () => {
    const { connector } = fakeConnector({ messages: [] });
    mockBuildConnector.mockReturnValue(connector);
    const run = fetchEmails(accountId);
    expect(isFetching(accountId)).toBe(true);
    await run;
    expect(isFetching(accountId)).toBe(false);
  });
});

describe("автоанализ", () => {
  test("при включённой настройке письмо ставится в очередь", async () => {
    setSetting("auto_analyze", "true");
    const { connector } = fakeConnector({ messages: [{ uid: "50", source: rawEmail() }] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  test("при выключенной настройке анализ не запускается", async () => {
    const { connector } = fakeConnector({ messages: [{ uid: "51", source: rawEmail() }] });
    mockBuildConnector.mockReturnValue(connector);
    await fetchEmails(accountId);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

/** Письмо с двумя вложениями, у которых ОДИНАКОВОЕ имя файла. */
function emailWithTwoSameNamedAttachments(): Buffer {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  return Buffer.from(
    [
      "From: sender@test.local",
      "To: receiver@test.local",
      "Subject: Два акта",
      "Date: Wed, 15 Jan 2026 10:00:00 +0300",
      "Message-ID: <two-acts@test.local>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BOUND"',
      "",
      "--BOUND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Во вложении два акта.",
      "--BOUND",
      'Content-Type: application/pdf; name="акт.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="акт.pdf"',
      "",
      b64("первый акт"),
      "--BOUND",
      'Content-Type: application/pdf; name="акт.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="акт.pdf"',
      "",
      b64("второй акт"),
      "--BOUND--",
      ""
    ].join("\r\n"),
    "utf8"
  );
}

describe("вложения с одинаковым именем", () => {
  test("два «акт.pdf» в одном письме — два файла, оба читаются", async () => {
    const res = await importEmails(accountId, "Imported", [
      { filename: "two-acts.eml", data: emailWithTwoSameNamedAttachments() }
    ]);
    expect(res.added).toBe(1);

    const email = listEmails({ accountId, folder: "Imported" }).find((e) => e.subject === "Два акта")!;
    const atts = listAttachments(email.id);
    expect(atts).toHaveLength(2);
    expect(atts.map((a) => a.filename)).toEqual(["акт.pdf", "акт.pdf"]);

    // Раньше путь был один и тот же: второе вложение затирало первое, и в
    // списке было два файла, а открывался один.
    expect(atts[0].storagePath).not.toBe(atts[1].storagePath);
    expect(fs.readFileSync(atts[0].storagePath!, "utf8")).toBe("первый акт");
    expect(fs.readFileSync(atts[1].storagePath!, "utf8")).toBe("второй акт");
  });
});

/** Письмо с вложением, названным как устройство Windows. */
function emailWithDeviceNamedAttachment(): Buffer {
  return Buffer.from(
    [
      "From: sender@test.local",
      "To: receiver@test.local",
      "Subject: Устройство",
      "Date: Wed, 15 Jan 2026 10:00:00 +0300",
      "Message-ID: <device-name@test.local>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BOUND"',
      "",
      "--BOUND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Во вложении файл с именем устройства.",
      "--BOUND",
      'Content-Type: application/octet-stream; name="CON"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="CON"',
      "",
      Buffer.from("данные", "utf8").toString("base64"),
      "--BOUND--",
      ""
    ].join("\r\n"),
    "utf8"
  );
}

describe("имена-устройства Windows", () => {
  test("вложение «CON» сохраняется, письмо не теряется", async () => {
    const res = await importEmails(accountId, "Imported", [
      { filename: "con.eml", data: emailWithDeviceNamedAttachment() }
    ]);
    // Раньше падение на имени вложения уносило письмо целиком.
    expect(res.added).toBe(1);

    const email = listEmails({ accountId, folder: "Imported" }).find((e) => e.subject === "Устройство")!;
    expect(email).toBeTruthy();
    const atts = listAttachments(email.id);
    expect(atts).toHaveLength(1);
    // В интерфейсе имя исходное, на диске — безопасное.
    expect(atts[0].filename).toBe("CON");
    expect(fs.readFileSync(atts[0].storagePath!, "utf8")).toBe("данные");
  });
});

describe("импорт из файлов", () => {
  test("eml-файл импортируется", async () => {
    const res = await importEmails(accountId, "Imported", [
      { filename: "letter.eml", data: rawEmail({ subject: "Из файла" }) }
    ]);
    expect(res.added).toBe(1);
    expect(listEmails({ accountId }).some((e) => e.subject === "Из файла")).toBe(true);
  });

  test("повторный импорт того же файла пропускается", async () => {
    const data = rawEmail({ messageId: "<import-dup@test.local>" });
    const first = await importEmails(accountId, "Imported", [{ filename: "a.eml", data }]);
    const second = await importEmails(accountId, "Imported", [{ filename: "a.eml", data }]);
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("mbox с двумя письмами даёт два письма", async () => {
    const mbox = Buffer.from(
      [
        "From a@test.local Mon Jan  1 00:00:00 2026",
        "Subject: Mbox-1",
        "Message-ID: <mbox1@test.local>",
        "",
        "тело 1",
        "From b@test.local Tue Jan  2 00:00:00 2026",
        "Subject: Mbox-2",
        "Message-ID: <mbox2@test.local>",
        "",
        "тело 2"
      ].join("\n"),
      "utf8"
    );
    const res = await importEmails(accountId, "Imported", [{ filename: "archive.mbox", data: mbox }]);
    expect(res.added).toBe(2);
  });

  test("письмо без Message-ID получает синтетический и не считается дублем", async () => {
    const data = rawEmail({ messageId: null });
    const first = await importEmails(accountId, "Imported", [{ filename: "noid.eml", data }]);
    const second = await importEmails(accountId, "Imported", [{ filename: "noid.eml", data }]);
    // Иначе UNIQUE-констрейнт по message_id ронял бы импорт.
    expect(first.added).toBe(1);
    expect(second.added).toBe(1);
  });

  test("мусорный файл пропускается, а остальные импортируются", async () => {
    const res = await importEmails(accountId, "Imported", [
      { filename: "мусор.eml", data: Buffer.from("это не письмо") },
      { filename: "нормальное.eml", data: rawEmail({ subject: "Уцелевшее" }) }
    ]);
    // Мусор не должен превращаться в пустое письмо в списке.
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
    expect(listEmails({ accountId }).some((e) => e.subject === "Уцелевшее")).toBe(true);
  });

  test("пустой список файлов даёт нули", async () => {
    expect(await importEmails(accountId, "Imported", [])).toEqual({ added: 0, skipped: 0 });
  });
});
