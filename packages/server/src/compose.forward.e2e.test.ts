import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Пересылка письма с вложениями — сквозь весь путь: HTTP → почтовое ядро → файл → SMTP.
 *
 * Проверяем главный риск: вложение видно в интерфейсе, а отправить нечего. Шаблон
 * пересылки больше не несёт base64 (письмо на 20 МБ превращалось в ~27 МБ JSON),
 * но файл обязан реально дойти до адресата — теми же байтами и под тем же именем.
 *
 * Ядро здесь настоящее (SQLite во временном каталоге), «адресат» — мини-SMTP на
 * 127.0.0.1. Не подменяются ни composeService, ни sendService — только внешние
 * границы: очередь (p-queue — ESM, в jest не грузится) и документооборот (PostgreSQL).
 */

jest.mock("../../core/src/analysis/queue", () => {
  class FakeQueue {
    concurrency = 1;
    add<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
    get size(): number {
      return 0;
    }
    get pending(): number {
      return 0;
    }
    clear(): void {
      /* пусто */
    }
  }
  return { __esModule: true, analysisQueue: new FakeQueue(), ocrQueue: new FakeQueue() };
});

jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };

/** Мини-SMTP: принимает письмо целиком и складывает в messages — это и есть «адресат». */
async function startSmtp(): Promise<{ port: number; messages: Buffer[]; close: () => Promise<void> }> {
  const messages: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let collecting = false;
    let message = Buffer.alloc(0);
    socket.write("220 mailsense-test ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (collecting) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) {
          message = Buffer.concat([message, buffer]);
          buffer = Buffer.alloc(0);
          return;
        }
        // Письмо у адресата: точка — конец DATA, её в тело не включаем.
        messages.push(Buffer.concat([message, buffer.subarray(0, end)]));
        buffer = buffer.subarray(end + 5);
        message = Buffer.alloc(0);
        collecting = false;
        socket.write("250 2.0.0 Ok: queued\r\n");
      }
      let nl = buffer.indexOf("\r\n");
      while (!collecting && nl >= 0) {
        const line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 2);
        const command = line.split(" ")[0].toUpperCase();
        if (command === "EHLO" || command === "HELO") {
          // AUTH не объявляем: nodemailer тогда его и не пытается.
          socket.write("250-mailsense-test\r\n250 SIZE 104857600\r\n");
        } else if (command === "MAIL" || command === "RCPT") {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (command === "DATA") {
          collecting = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          break;
        } else if (command === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
        nl = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

interface TemplateBody {
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string; emailId: string }>;
  subject: string;
}

/** Имя вложения из MIME: не-ASCII nodemailer кодирует по RFC 2231 и режет на продолжения. */
function attachmentName(header: string): string {
  const chunks: string[] = [];
  const re = /filename\*(\d+)\*=([^\r\n;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) chunks[Number(m[1])] = m[2];
  if (chunks.length) return decodeURIComponent(chunks.filter(Boolean).join("").replace(/^utf-8''/i, ""));
  const plain = /filename="?([^"\r\n;]+)"?/.exec(header);
  return plain ? plain[1] : "";
}

/** Вложения из принятого письма: имя и раскодированные байты. */
function parseAttachments(mime: string): Array<{ name: string; data: Buffer }> {
  return mime
    .split(/Content-Disposition: attachment/i)
    .slice(1)
    .map((chunk) => {
      const headerEnd = chunk.indexOf("\r\n\r\n");
      const header = headerEnd >= 0 ? chunk.slice(0, headerEnd) : chunk;
      const body = headerEnd >= 0 ? chunk.slice(headerEnd + 4) : "";
      const payload = body.split(/\r\n--/)[0].replace(/\r?\n/g, "");
      return { name: attachmentName(header), data: Buffer.from(payload, "base64") };
    });
}

let dir = "";
let app: RunningApp;
let smtp: { port: number; messages: Buffer[]; close: () => Promise<void> };
let accountId = "";
let emailId = "";

// Кириллица, пробел и скобки в имени — и то же самое имя у второго вложения.
const NAME_A = "Договор (копия).pdf";
const NAME_B = "Договор (копия).pdf";
const CONTENT_A = Buffer.from("первый файл: содержимое А", "utf8");
const CONTENT_B = Buffer.from("второй файл: содержимое Б", "utf8");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-forward-"));
  smtp = await startSmtp();
  core.initApp({ dataDir: dir });

  const account = core.createAccount({
    // POP3: копию в «Отправленные» по IMAP не дописываем — чужого сервера в тесте нет.
    protocol: "pop3",
    host: "127.0.0.1",
    port: 1,
    tls: "none",
    authType: "login",
    username: "forwarder@mail.test",
    password: "почта",
    smtpHost: "127.0.0.1",
    smtpPort: smtp.port,
    smtpTls: "none",
    settings: { signatureEnabled: false }
  });
  accountId = account.id;

  const email = core.insertEmail({
    accountId,
    folder: "INBOX",
    uid: "uid-forward-1",
    messageId: "original@test.local",
    subject: "Письмо с вложениями",
    from: { name: "Отправитель", address: "sender@test.local" },
    to: [{ address: "forwarder@mail.test" }],
    cc: [],
    replyTo: null,
    inReplyTo: null,
    references: [],
    date: "2026-10-06T09:00:00.000Z",
    bodyText: "Текст оригинала",
    bodyHtml: null,
    headers: {}
  });
  emailId = email.id;

  const fileA = path.join(dir, "a.bin");
  const fileB = path.join(dir, "b.bin");
  fs.writeFileSync(fileA, CONTENT_A);
  fs.writeFileSync(fileB, CONTENT_B);
  core.insertAttachment({
    emailId, filename: NAME_A, mimeType: "application/pdf", size: CONTENT_A.length,
    storagePath: fileA, extractedText: null, contentId: null, kind: "pdf", handled: true
  });
  core.insertAttachment({
    emailId, filename: NAME_B, mimeType: "application/pdf", size: CONTENT_B.length,
    storagePath: fileB, extractedText: null, contentId: null, kind: "pdf", handled: true
  });

  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
  await smtp.close();
  core.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* на Windows каталог может быть ещё занят */
  }
});

async function forwardTemplate(): Promise<{ status: number; text: string; body: TemplateBody }> {
  const res = await request(
    app.baseUrl,
    "GET",
    "/api/compose-template?accountId=" + accountId + "&mode=forward&emailId=" + emailId,
    { token: "token:admin" }
  );
  return { status: res.status, text: res.text, body: res.body as TemplateBody };
}

/** Ровно то, что делает клиент: тянет файл по ссылке и кодирует base64. */
async function materialize(tpl: TemplateBody): Promise<Array<{ filename: string; mimeType: string; size: number; data: string }>> {
  const out: Array<{ filename: string; mimeType: string; size: number; data: string }> = [];
  for (const att of tpl.attachments) {
    const res = await fetch(
      app.baseUrl + "/api/emails/" + att.emailId + "/attachments/" + att.attachmentId + "/file",
      { headers: { authorization: "Bearer token:admin" } }
    );
    expect(res.status).toBe(200);
    out.push({
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      data: Buffer.from(await res.arrayBuffer()).toString("base64")
    });
  }
  return out;
}

function lastMime(): string {
  return smtp.messages[smtp.messages.length - 1].toString("latin1");
}

function sendBody(attachments: unknown, subject = "Fwd: Письмо с вложениями") {
  return {
    accountId,
    to: [{ address: "client@test.local" }],
    subject,
    bodyText: "Пересылаю",
    attachments
  };
}

describe("шаблон пересылки: ссылки вместо файлов", () => {
  it("отдаёт по ссылке на каждое вложение и ни байта данных", async () => {
    const tpl = await forwardTemplate();

    expect(tpl.status).toBe(200);
    expect(tpl.body.attachments).toHaveLength(2);
    expect(tpl.body.attachments.map((a) => [a.filename, a.attachmentId])).toEqual([
      [NAME_A, expect.any(String)],
      [NAME_B, expect.any(String)]
    ]);
    expect(tpl.body.attachments.map((a) => a.size)).toEqual([CONTENT_A.length, CONTENT_B.length]);
    expect(tpl.body.attachments.every((a) => a.emailId === emailId)).toBe(true);

    // Приёмка: в теле ответа /api/compose-template нет данных вложений.
    expect(tpl.text).not.toContain(CONTENT_A.toString("base64"));
    expect(tpl.text).not.toContain(CONTENT_B.toString("base64"));
    // Оценка размера ответа: раньше здесь лежали сами файлы.
    expect(tpl.text.length).toBeLessThan(CONTENT_A.toString("base64").length + CONTENT_B.toString("base64").length + 5000);
  });

  it("файл по ссылке отдаётся теми же байтами", async () => {
    const tpl = await forwardTemplate();
    const files = await materialize(tpl.body);
    expect(Buffer.from(files[0].data, "base64").equals(CONTENT_A)).toBe(true);
    expect(Buffer.from(files[1].data, "base64").equals(CONTENT_B)).toBe(true);
  });
});

describe("пересылка доходит до адресата", () => {
  it("немедленная отправка: те же два файла, имена не потеряны", async () => {
    const tpl = await forwardTemplate();
    const attachments = await materialize(tpl.body);

    const sent = await request(app.baseUrl, "POST", "/api/emails/send", {
      token: "token:admin",
      body: sendBody(attachments)
    });

    expect(sent.status).toBe(201);
    const files = parseAttachments(lastMime());
    expect(files.map((f) => f.name)).toEqual([NAME_A, NAME_B]);
    expect(files[0].data.equals(CONTENT_A)).toBe(true);
    expect(files[1].data.equals(CONTENT_B)).toBe(true);

    // Копия в «Отправленных» обязана показывать то, что ушло: иначе человек открывает
    // отправленное письмо и не видит файлов (раньше строк вложений у копии не было вовсе).
    const sentId = (sent.body as { emailId: string }).emailId;
    const copy = await request(app.baseUrl, "GET", "/api/emails/" + sentId, { token: "token:admin" });
    const copyAtts = (
      copy.body as { attachments: Array<{ id: string; emailId: string; filename: string; size: number }> }
    ).attachments;
    expect(copyAtts.map((a) => [a.filename, a.size])).toEqual([
      [NAME_A, CONTENT_A.length],
      [NAME_B, CONTENT_B.length]
    ]);

    // И файлы из копии скачиваются теми же байтами — тем же маршрутом, что и у входящих.
    const copyFiles = await materialize({
      subject: "",
      attachments: copyAtts.map((a) => ({
        filename: a.filename,
        mimeType: "application/pdf",
        size: a.size,
        attachmentId: a.id,
        emailId: a.emailId
      }))
    });
    expect(Buffer.from(copyFiles[0].data, "base64").equals(CONTENT_A)).toBe(true);
    expect(Buffer.from(copyFiles[1].data, "base64").equals(CONTENT_B)).toBe(true);
  });

  it("черновик: данные переживают запись и чтение, отправка из черновика доносит файлы", async () => {
    const tpl = await forwardTemplate();
    const attachments = await materialize(tpl.body);

    const created = await request(app.baseUrl, "POST", "/api/drafts", {
      token: "token:admin",
      body: { ...sendBody(attachments, "Fwd: черновик"), cc: [], bcc: [], bodyHtml: null }
    });
    expect(created.status).toBe(201);
    const draftId = (created.body as { id: string }).id;

    // Клиент открывает черновик из списка — вложения должны прийти с данными.
    const list = await request(app.baseUrl, "GET", "/api/drafts?accountId=" + accountId, {
      token: "token:admin"
    });
    const draft = (list.body as Array<{ id: string; subject: string; bodyText: string; attachments: unknown }>).find(
      (d) => d.id === draftId
    );
    expect(draft).toBeDefined();
    expect(draft!.attachments).toEqual(attachments);

    const sent = await request(app.baseUrl, "POST", "/api/emails/send", {
      token: "token:admin",
      body: { ...sendBody(draft!.attachments, draft!.subject), bodyText: draft!.bodyText }
    });

    expect(sent.status).toBe(201);
    const files = parseAttachments(lastMime());
    expect(files.map((f) => f.name)).toEqual([NAME_A, NAME_B]);
    expect(files[0].data.equals(CONTENT_A)).toBe(true);
    expect(files[1].data.equals(CONTENT_B)).toBe(true);
  });
});

describe("вложение без данных не превращается в письмо без вложения", () => {
  it("отправка ссылки без данных — 400 с понятным текстом, письмо не уходит", async () => {
    const before = smtp.messages.length;
    const res = await request(app.baseUrl, "POST", "/api/emails/send", {
      token: "token:admin",
      body: sendBody([{ filename: NAME_A, mimeType: "application/pdf", attachmentId: "att-1", emailId }])
    });

    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error)).toContain(NAME_A);
    // Молча отправить письмо без файла, который человек видит в окне, нельзя.
    expect(smtp.messages.length).toBe(before);
  });

  it("черновик со ссылкой вместо данных — 400, черновик не создаётся", async () => {
    const res = await request(app.baseUrl, "POST", "/api/drafts", {
      token: "token:admin",
      body: { ...sendBody([{ filename: NAME_B, mimeType: "application/pdf", attachmentId: "att-2", emailId }]), cc: [], bcc: [] }
    });

    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error)).toContain(NAME_B);
  });
});