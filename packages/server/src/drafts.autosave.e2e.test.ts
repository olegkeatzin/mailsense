import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Черновик с вложениями: автосохранение не гоняет base64, а отправка доносит файлы.
 *
 * ⚠️ Главный риск — тихая потеря вложения: человек видит файл в окне, а письмо уходит
 * без него. Поэтому здесь сквозной путь целиком: шаблон пересылки → черновик → автосохранение
 * → отправка → «адресат» (мини-SMTP) — и в конце сверяются БАЙТЫ, а не имена.
 *
 * Ядро настоящее (SQLite во временном каталоге), подменены только внешние границы:
 * очередь разбора (p-queue — ESM, в jest не грузится) и документооборот (PostgreSQL).
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
import { listen, request, stillAlive, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";
import { parseAttachments, startSmtp, type FakeSmtp } from "./testing/smtpHarness.js";

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };

const TOKEN = "token:admin";
const NAME = "Договор (копия).pdf";
const CONTENT_A = Buffer.from("первый файл: содержимое А", "utf8");
const CONTENT_B = Buffer.from("второй файл: содержимое Б", "utf8");

interface DraftAttachmentBody {
  filename: string;
  mimeType: string;
  size: number;
  ref?: string;
  data?: string;
}

let dir = "";
let app: RunningApp;
let smtp: FakeSmtp;
let accountId = "";
let emailId = "";

const draftDir = (draftId: string): string => path.join(dir, "drafts", draftId);

/** Байты файлов черновика: сколько их и что внутри. */
function draftFiles(draftId: string): Buffer[] {
  const folder = draftDir(draftId);
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .sort()
    .map((f) => fs.readFileSync(path.join(folder, f)));
}

/** Скачивает содержимое по ссылке — так же, как это делал бы клиент. */
async function downloadDraftAttachment(draftId: string, ref: string): Promise<{ status: number; bytes: Buffer }> {
  const res = await fetch(app.baseUrl + "/api/drafts/" + draftId + "/attachments/" + encodeURIComponent(ref) + "/file", {
    headers: { authorization: "Bearer " + TOKEN }
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-drafts-"));
  smtp = await startSmtp();
  core.initApp({ dataDir: dir });

  const account = core.createAccount({
    // POP3: копию в «Отправленные» по IMAP не дописываем — чужого сервера в тесте нет.
    protocol: "pop3",
    host: "127.0.0.1",
    port: 1,
    tls: "none",
    authType: "login",
    username: "drafter@mail.test",
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
    uid: "uid-draft-1",
    messageId: "draft-original@test.local",
    subject: "Письмо с вложениями",
    from: { name: "Отправитель", address: "sender@test.local" },
    to: [{ address: "drafter@mail.test" }],
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
    emailId, filename: NAME, mimeType: "application/pdf", size: CONTENT_A.length,
    storagePath: fileA, extractedText: null, contentId: null, kind: "pdf", handled: true
  });
  core.insertAttachment({
    emailId, filename: NAME, mimeType: "application/pdf", size: CONTENT_B.length,
    storagePath: fileB, extractedText: null, contentId: null, kind: "pdf", handled: true
  });

  mocked.__sessions.set(TOKEN, testUser("u-admin", ["admin"]));
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

/** Ссылки на вложения письма — то, что отдаёт шаблон пересылки. */
async function forwardRefs(): Promise<Array<{ filename: string; mimeType: string; size: number; attachmentId: string; emailId: string }>> {
  const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=" + accountId + "&mode=forward&emailId=" + emailId, {
    token: TOKEN
  });
  expect(res.status).toBe(200);
  return (res.body as { attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string; emailId: string }> }).attachments;
}

/** Черновик так, как его создаёт интерфейс: вложения — ссылками на файлы письма, без base64. */
async function createDraftFromForward(subject = "Черновик с вложениями"): Promise<{ id: string; attachments: DraftAttachmentBody[]; subject: string; bodyText: string }> {
  const refs = await forwardRefs();
  const body = {
    accountId,
    to: [{ address: "client@test.local" }],
    cc: [],
    bcc: [],
    subject,
    bodyText: "текст письма",
    bodyHtml: null,
    attachments: refs.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      emailRef: { emailId: a.emailId, attachmentId: a.attachmentId }
    }))
  };
  // Автосохранение пересылки не должно нести base64 вообще: файл сервер берёт из письма.
  expect(JSON.stringify(body)).not.toContain(CONTENT_A.toString("base64"));
  expect(JSON.stringify(body)).not.toContain(CONTENT_B.toString("base64"));

  const res = await request(app.baseUrl, "POST", "/api/drafts", { token: TOKEN, body });
  expect(res.status).toBe(201);
  return res.body as { id: string; attachments: DraftAttachmentBody[]; subject: string; bodyText: string };
}

describe("черновик: данные вложений живут файлами, а не base64 в JSON", () => {
  it("первое сохранение раскладывает вложения в файлы и не кладёт base64 в черновик", async () => {
    const draft = await createDraftFromForward();

    expect(draft.attachments).toHaveLength(2);
    expect(draft.attachments.map((a) => [a.filename, a.size])).toEqual([
      [NAME, CONTENT_A.length],
      [NAME, CONTENT_B.length]
    ]);
    // В ответе и в базе — только ссылки на файлы.
    expect(draft.attachments.every((a) => typeof a.ref === "string" && a.ref.length > 0)).toBe(true);
    expect(draft.attachments.every((a) => a.data === undefined)).toBe(true);
    expect(JSON.stringify(draft)).not.toContain(CONTENT_A.toString("base64"));

    // ⚠️ Имя не уникально: два «Договор (копия).pdf» обязаны лечь в РАЗНЫЕ файлы.
    expect(new Set(draft.attachments.map((a) => a.ref)).size).toBe(2);
    const files = draftFiles(draft.id);
    expect(files).toHaveLength(2);
    expect(files.map((b) => b.toString("utf8")).sort()).toEqual(
      [CONTENT_A.toString("utf8"), CONTENT_B.toString("utf8")].sort()
    );
  });

  it("содержимое отдаётся по ссылке тем же байтом, чужая ссылка — 404", async () => {
    const draft = await createDraftFromForward();
    const got: Buffer[] = [];
    for (const att of draft.attachments) {
      const res = await downloadDraftAttachment(draft.id, att.ref as string);
      expect(res.status).toBe(200);
      expect(res.bytes.length).toBe(att.size);
      got.push(res.bytes);
    }
    expect(got.map((b) => b.toString("utf8")).sort()).toEqual(
      [CONTENT_A.toString("utf8"), CONTENT_B.toString("utf8")].sort()
    );

    const foreign = await downloadDraftAttachment(draft.id, "нет-такого-файла.pdf");
    expect(foreign.status).toBe(404);
  });

  it("периодическое автосохранение несёт только ссылки и не теряет вложения", async () => {
    const draft = await createDraftFromForward();

    // Ровно то, что отправляет клиент через 15 секунд: ни байта данных.
    const autosave = {
      subject: "Черновик изменён",
      attachments: draft.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, ref: a.ref }))
    };
    expect(JSON.stringify(autosave)).not.toContain(CONTENT_A.toString("base64"));
    expect(JSON.stringify(autosave)).not.toContain(CONTENT_B.toString("base64"));

    const put = await request(app.baseUrl, "PUT", "/api/drafts/" + draft.id, { token: TOKEN, body: autosave });
    expect(put.status).toBe(200);
    expect((put.body as { attachments: DraftAttachmentBody[] }).attachments).toEqual(draft.attachments);

    // Файлы не размножились и не перезаписались.
    expect(draftFiles(draft.id)).toHaveLength(2);

    // И в базе base64 нет — ни у этого черновика, ни у списка.
    const listed = await request(app.baseUrl, "GET", "/api/drafts?accountId=" + accountId, { token: TOKEN });
    expect(JSON.stringify(listed.body)).not.toContain(CONTENT_A.toString("base64"));
    expect(JSON.stringify(listed.body)).not.toContain(CONTENT_B.toString("base64"));
  });

  it("свежий файл из окна (data) раскладывается в файл, в ответе — ссылка", async () => {
    const res = await request(app.baseUrl, "POST", "/api/drafts", {
      token: TOKEN,
      body: {
        accountId,
        to: [{ address: "client@test.local" }],
        subject: "Новый черновик",
        bodyText: "текст",
        attachments: [{ filename: "счёт.pdf", mimeType: "application/pdf", size: CONTENT_A.length, data: CONTENT_A.toString("base64") }]
      }
    });

    expect(res.status).toBe(201);
    const att = (res.body as { attachments: DraftAttachmentBody[] }).attachments[0];
    expect(att.data).toBeUndefined();
    expect(typeof att.ref).toBe("string");
    expect(att.size).toBe(CONTENT_A.length);
    const files = draftFiles((res.body as { id: string }).id);
    expect(files).toHaveLength(1);
    expect(files[0].equals(CONTENT_A)).toBe(true);
  });
});

describe("отправка из черновика", () => {
  it("по ссылкам доносит те же файлы байт в байт и оставляет их в «Отправленных»", async () => {
    const draft = await createDraftFromForward();

    // Тело отправки: ссылки, ни одного байта base64 — сервер читает файлы сам.
    const body = {
      accountId,
      to: [{ address: "client@test.local" }],
      subject: draft.subject,
      bodyText: draft.bodyText,
      attachments: draft.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        ref: a.ref,
        draftId: draft.id
      }))
    };
    expect(JSON.stringify(body)).not.toContain(CONTENT_A.toString("base64"));
    expect(JSON.stringify(body)).not.toContain(CONTENT_B.toString("base64"));

    const sent = await request(app.baseUrl, "POST", "/api/emails/send", { token: TOKEN, body });
    expect(sent.status).toBe(201);

    const mime = smtp.messages[smtp.messages.length - 1].toString("latin1");
    const files = parseAttachments(mime);
    expect(files.map((f) => f.name)).toEqual([NAME, NAME]);
    expect(files[0].data.equals(CONTENT_A)).toBe(true);
    expect(files[1].data.equals(CONTENT_B)).toBe(true);

    // Копия в «Отправленных» показывает то, что ушло.
    const copy = await request(app.baseUrl, "GET", "/api/emails/" + (sent.body as { emailId: string }).emailId, {
      token: TOKEN
    });
    expect((copy.body as { attachments: unknown[] }).attachments).toHaveLength(2);
  });

  it("битая ссылка — 400 и письмо не уходит; вложение не теряется молча", async () => {
    const draft = await createDraftFromForward();
    const before = smtp.messages.length;

    const broken = await request(app.baseUrl, "POST", "/api/emails/send", {
      token: TOKEN,
      body: {
        accountId,
        to: [{ address: "client@test.local" }],
        subject: "битая ссылка",
        bodyText: "текст",
        attachments: [{ filename: NAME, mimeType: "application/pdf", size: 1, ref: "нет-такого-файла.pdf", draftId: draft.id }]
      }
    });
    expect(broken.status).toBe(400);
    expect(String((broken.body as { error?: string }).error)).toContain(NAME);

    const noDraft = await request(app.baseUrl, "POST", "/api/emails/send", {
      token: TOKEN,
      body: {
        accountId,
        to: [{ address: "client@test.local" }],
        subject: "чужой черновик",
        bodyText: "текст",
        attachments: [{ filename: NAME, mimeType: "application/pdf", size: 1, ref: draft.attachments[0].ref, draftId: "нет-такого-черновика" }]
      }
    });
    expect(noDraft.status).toBe(400);

    expect(smtp.messages.length).toBe(before);
  });
});

/** Черновик с одним «свежим» файлом — как будто человек выбрал его в окне. */
async function createDraftWithFile(filename: string, content: Buffer): Promise<{ id: string; attachments: DraftAttachmentBody[] }> {
  const res = await request(app.baseUrl, "POST", "/api/drafts", {
    token: TOKEN,
    body: {
      accountId,
      to: [{ address: "client@test.local" }],
      subject: "Черновик с файлом",
      bodyText: "текст",
      attachments: [{ filename, mimeType: "application/octet-stream", size: content.length, data: content.toString("base64") }]
    }
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; attachments: DraftAttachmentBody[] };
}

describe("отдача файла черновика", () => {
  it("обрыв скачивания закрывает поток — дескриптор не остаётся открытым", async () => {
    // Файл заметно больше одного чанка: обрываем чтение на середине.
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const draft = await createDraftWithFile("большой.bin", big);
    const ref = draft.attachments[0].ref as string;

    // ⚠️ Проверяем сам поток, а не файл: на Windows переименование и удаление открытого
    // файла проходят (libuv открывает с FILE_SHARE_DELETE), поэтому утечку они не ловят.
    const realCreate = fs.createReadStream;
    let captured: fs.ReadStream | null = null;
    const spy = jest.spyOn(fs, "createReadStream").mockImplementation(((...args: unknown[]) => {
      const stream = (realCreate as (...a: unknown[]) => fs.ReadStream)(...args);
      captured = stream;
      return stream;
    }) as unknown as typeof fs.createReadStream);

    try {
      const controller = new AbortController();
      const response = await fetch(
        app.baseUrl + "/api/drafts/" + draft.id + "/attachments/" + encodeURIComponent(ref) + "/file",
        { headers: { authorization: "Bearer " + TOKEN }, signal: controller.signal }
      );
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(captured).not.toBeNull();
      expect((captured as unknown as fs.ReadStream).closed).toBe(true);
      // И сервер продолжает обслуживать запросы.
      expect(await stillAlive(app.baseUrl)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 20000);
});

describe("уборка за черновиком", () => {
  it("удаление черновика убирает его файлы", async () => {
    const draft = await createDraftFromForward("Черновик на удаление");
    expect(fs.existsSync(draftDir(draft.id))).toBe(true);

    const del = await request(app.baseUrl, "DELETE", "/api/drafts/" + draft.id, { token: TOKEN });
    expect(del.status).toBe(200);
    expect(fs.existsSync(draftDir(draft.id))).toBe(false);
  });
});
