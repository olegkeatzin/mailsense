import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Регрессия: анализ письма не должен плодить копии вложений на диске.
 *
 * ⚠️ Модуль вложений (attachments/index.js, store.ts) здесь НЕ подменяется —
 * смысл проверки именно в реальной записи файла. До правки повторный проход
 * анализа оставлял на диске ещё одну копию вложения («акт.txt» → «акт-1.txt»),
 * потому что prepareAttachment сохранял файл всегда, а уникализация имён
 * (flag "wx" + суффикс) больше не перезаписывает существующий путь. Копии не
 * попадают в БД: их не удаляет ни удаление письма, ни очистка вложений. Диск
 * рос на размер всех вложений при каждом «Проанализировать заново», а после
 * 1000 копий одного имени saveAttachmentFile бросает исключение и вложение
 * перестаёт анализироваться.
 */
const mockAnalyze = jest.fn();

jest.mock("../ai/analyze.js", () => ({
  __esModule: true,
  analyzeEmailRaw: (...args: unknown[]) => mockAnalyze(...args)
}));

// OCR в этом сценарии не нужен: вложение текстовое, картинок нет.
jest.mock("../ai/ocr.js", () => ({
  __esModule: true,
  ocrImage: async () => ""
}));

// pdfjs-dist — ESM, в jest не грузится. Это разбор PDF, а не хранение вложений:
// запись файла и извлечение текста идут через настоящие store.ts/index.ts.
jest.mock("../attachments/pdf.js", () => ({
  __esModule: true,
  pdfToImages: async () => ({ pages: [], totalPages: 0, truncated: false }),
  pdfToText: async () => "",
  pdfPageToImage: async () => null
}));

/** p-queue — ESM-пакет, который jest в режиме CommonJS не загружает. */
jest.mock("../analysis/queue.js", () => {
  class FakeQueue {
    concurrency = 1;
    private tasks: Array<() => void> = [];
    private active = 0;
    get size(): number {
      return this.tasks.length;
    }
    get pending(): number {
      return this.active;
    }
    add<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = (): void => {
          this.active++;
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.pump();
            });
        };
        this.tasks.push(run);
        this.pump();
      });
    }
    private pump(): void {
      while (this.active < this.concurrency && this.tasks.length > 0) this.tasks.shift()!();
    }
    clear(): void {
      this.tasks = [];
    }
  }
  return { __esModule: true, analysisQueue: new FakeQueue(), ocrQueue: new FakeQueue() };
});

import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { insertAttachment, insertEmail, listAccounts } from "../repos.js";
import { saveAttachmentFile } from "../attachments/store.js";
import { runAnalysis } from "./analysisService.js";
import { setAiConfig } from "./settingsService.js";

let dir = "";
let accountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-analysis-files-"));
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
  mockAnalyze.mockReset();
  setAiConfig({ baseUrl: "http://ai.test/v1", model: "test-model" });
});

function okResponse(): string {
  return JSON.stringify({
    summary: "Краткая суть",
    tags: ["тег"],
    priority: 3,
    urgent: false,
    event_date: null,
    external_number: null,
    external_number_source: null,
    send_date: null,
    category: "work",
    attachments: []
  });
}

/** Письмо с одним уже сохранённым вложением — как после скана ящика. */
function emailWithAttachment(filename = "акт.txt", text = "содержимое акта") {
  const email = insertEmail({
    accountId,
    folder: "INBOX",
    uid: "uid-" + randomUUID(),
    messageId: randomUUID() + "@test.local",
    subject: "Письмо с вложением",
    from: { name: "Отправитель", address: "sender@test.local" },
    to: [],
    cc: [],
    inReplyTo: null,
    references: [],
    date: "2026-01-15T10:00:00.000Z",
    bodyText: "Текст письма",
    bodyHtml: null,
    headers: {}
  });
  const buf = Buffer.from(text, "utf8");
  const storagePath = saveAttachmentFile(dir, email.id, filename, buf);
  insertAttachment({
    emailId: email.id,
    filename,
    mimeType: "text/plain",
    size: buf.length,
    storagePath,
    extractedText: null,
    contentId: null,
    kind: "text",
    handled: true
  });
  return email;
}

function attachmentDir(emailId: string): string {
  return path.join(dir, "attachments", emailId);
}

function filesIn(emailId: string): string[] {
  const d = attachmentDir(emailId);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}

describe("файлы вложений при анализе", () => {
  test("повторный анализ не создаёт копий вложения на диске", async () => {
    const email = emailWithAttachment();
    mockAnalyze.mockResolvedValue(okResponse());

    const before = filesIn(email.id);
    expect(before).toEqual(["акт.txt"]);

    await runAnalysis(email.id);
    // «Проанализировать заново» — тот самый второй прогон.
    await runAnalysis(email.id);

    // С копией было бы ["акт-1.txt", "акт.txt"]: файл есть, а записи в БД нет,
    // поэтому удаление письма его не уберёт.
    expect(filesIn(email.id)).toEqual(before);
  });

  test("текст вложения по-прежнему доходит до модели", async () => {
    const email = emailWithAttachment("акт.txt", "уникальный-текст-вложения");
    mockAnalyze.mockResolvedValue(okResponse());

    await runAnalysis(email.id);

    expect(mockAnalyze).toHaveBeenCalled();
    // Отказ от записи файла не должен ломать извлечение содержимого.
    expect(JSON.stringify(mockAnalyze.mock.calls)).toContain("уникальный-текст-вложения");
  });
});
