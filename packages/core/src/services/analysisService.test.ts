import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Конвейер анализа: OCR вложений → выжимка моделью → запись результата.
 * Модель и OCR подменены: проверяем оркестровку, статусы и обработку отказов,
 * а не качество ответов ИИ.
 */
const mockAnalyze = jest.fn();
const mockOcr = jest.fn();
const mockPrepare = jest.fn();

jest.mock("../ai/analyze.js", () => ({
  __esModule: true,
  analyzeEmailRaw: (...args: unknown[]) => mockAnalyze(...args)
}));
jest.mock("../ai/ocr.js", () => ({
  __esModule: true,
  ocrImage: (...args: unknown[]) => mockOcr(...args)
}));
jest.mock("../attachments/index.js", () => ({
  __esModule: true,
  prepareAttachment: (...args: unknown[]) => mockPrepare(...args)
}));

/**
 * p-queue — ESM-пакет, который jest в режиме CommonJS не загружает. Подменяем
 * минимальной очередью с тем же API (.add/.size/.pending/.clear/.concurrency):
 * заодно прогон становится детерминированным.
 */
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
import {
  deleteEmails,
  getAnalysis,
  getEmail,
  insertAttachment,
  insertEmail,
  listAccounts,
  listAttachments,
  listEmails
} from "../repos.js";
import {
  analyzeAllPending,
  analyzeEmails,
  analyzeRange,
  cancelAnalysis,
  enqueue,
  getProgress,
  queueLength,
  runAnalysis,
  stopAnalysis
} from "./analysisService.js";
import { setAiConfig } from "./settingsService.js";

let dir = "";
let accountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-analysis-"));
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
  mockOcr.mockReset();
  mockPrepare.mockReset();
  stopAnalysis(); // очередь — общее состояние модуля между тестами
  setAiConfig({ baseUrl: "http://ai.test/v1", model: "test-model" });
});

function ok(raw: Record<string, unknown> = {}): string {
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
    attachments: [],
    ...raw
  });
}

function makeEmail(over: { subject?: string; date?: string; messageId?: string } = {}) {
  return insertEmail({
    accountId,
    folder: "INBOX",
    uid: "uid-" + randomUUID(),
    messageId: over.messageId ?? randomUUID() + "@test.local",
    subject: over.subject ?? "Письмо",
    from: { name: "Отправитель", address: "sender@test.local" },
    to: [],
    cc: [],
    replyTo: [],
    inReplyTo: null,
    references: [],
    date: over.date ?? "2026-01-15T10:00:00.000Z",
    bodyText: "Текст письма",
    bodyHtml: null,
    headers: {}
  });
}

/** Реальный файл на диске: без него вложение пропускается. */
function makeAttachmentFile(content = "содержимое"): string {
  const p = path.join(dir, "att-" + randomUUID() + ".txt");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function prepared(over: Record<string, unknown> = {}) {
  return { filename: "doc.pdf", kind: "document", handled: true, storagePath: "", extractedText: "", images: [], ...over };
}

/** Ждём, пока очередь опустеет. */
async function drain(): Promise<void> {
  for (let i = 0; i < 100 && queueLength() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

describe("пустая дата события", () => {
  test("event_date = \"\" от модели кладёт в базу NULL", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ event_date: "" }));

    await runAnalysis(email.id);

    // Пустая строка — это «даты нет». Иначе письмо попадает в фильтр
    // «есть дата события» и от него строится событие календаря.
    expect(getAnalysis(email.id)!.eventDate).toBeNull();
  });

  test("строка из пробелов тоже не сохраняется как дата", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ event_date: "  " }));

    await runAnalysis(email.id);

    expect(getAnalysis(email.id)!.eventDate).toBeNull();
  });

  test("настоящая дата сохраняется как раньше", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ event_date: "2026-03-05" }));

    await runAnalysis(email.id);

    expect(getAnalysis(email.id)!.eventDate).toBe("2026-03-05");
  });
});

describe("успешный анализ", () => {
  test("результат сохраняется, статус становится «Готово»", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ summary: "Суть письма", tags: ["договор"], priority: 4 }));

    const res = await runAnalysis(email.id);

    expect(res).not.toBeNull();
    expect(getEmail(email.id)!.analysisStatus).toBe("ready");
    const saved = getAnalysis(email.id)!;
    expect(saved.summary).toBe("Суть письма");
    expect(saved.tags).toEqual(["договор"]);
    expect(saved.priority).toBe(4);
    expect(saved.modelUsed).toBe("test-model");
  });

  test("модель получает текст письма и имена вложений", async () => {
    const email = makeEmail({ subject: "Тема для модели" });
    const file = makeAttachmentFile();
    insertAttachment({
      emailId: email.id,
      filename: "акт.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: file,
      extractedText: "текст из документа",
      contentId: null,
      kind: "document",
      handled: true
    });
    mockPrepare.mockResolvedValue(prepared({ filename: "акт.pdf", extractedText: "текст из документа" }));
    mockAnalyze.mockResolvedValue(ok());

    await runAnalysis(email.id);

    const input = mockAnalyze.mock.calls[0][1];
    expect(input.subject).toBe("Тема для модели");
    expect(input.bodyText).toBe("Текст письма");
    expect(input.attachmentNames).toContain("акт.pdf");
    expect(input.attachmentTexts.join(" ")).toContain("текст из документа");
  });

  test("внешний номер и дата отправки заполняются, если их ещё нет", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ external_number: "1575/РТ", send_date: "2026-01-10" }));

    await runAnalysis(email.id);

    const updated = getEmail(email.id)!;
    expect(updated.externalNumber).toBe("1575/РТ");
    expect(updated.sendDate).toBe("2026-01-10");
  });

  test("уже заполненные реквизиты модель не перезаписывает", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ external_number: "из модели", send_date: "2026-02-02" }));
    await runAnalysis(email.id);

    // Второй прогон: письмо уже с номером, модель предлагает другой.
    mockAnalyze.mockResolvedValue(ok({ external_number: "другой", send_date: "2026-03-03" }));
    await runAnalysis(email.id);

    const updated = getEmail(email.id)!;
    expect(updated.externalNumber).toBe("из модели");
    expect(updated.sendDate).toBe("2026-02-02");
  });

  test("спам переносится в папку «Спам»", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok({ category: "spam" }));
    await runAnalysis(email.id);
    expect(getEmail(email.id)!.folder).toBe("SPAM");
  });

  test("источник номера привязывается к вложению", async () => {
    const email = makeEmail();
    const file = makeAttachmentFile();
    const att = insertAttachment({
      emailId: email.id,
      filename: "3175 от 31.08.2026.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: file,
      extractedText: "текст",
      contentId: null,
      kind: "document",
      handled: true
    });
    mockPrepare.mockResolvedValue(prepared({ filename: "3175 от 31.08.2026.pdf", extractedText: "текст" }));
    mockAnalyze.mockResolvedValue(
      ok({ external_number: "3175", external_number_source: { filename: "3175 от 31.08.2026.pdf", page: 2 } })
    );

    await runAnalysis(email.id);

    const updated = getEmail(email.id)!;
    expect(updated.numberSourceAttachmentId).toBe(att.id);
    expect(updated.numberSourcePage).toBe(2);
  });

  test("описания вложений из ответа сохраняются", async () => {
    const email = makeEmail();
    const file = makeAttachmentFile();
    insertAttachment({
      emailId: email.id,
      filename: "счёт.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: file,
      extractedText: "текст",
      contentId: null,
      kind: "document",
      handled: true
    });
    mockPrepare.mockResolvedValue(prepared({ filename: "счёт.pdf", extractedText: "текст" }));
    mockAnalyze.mockResolvedValue(ok({ attachments: [{ name: "счёт.pdf", description: "Счёт на оплату" }] }));

    await runAnalysis(email.id);

    expect(listAttachments(email.id)[0].aiDescription).toBe("Счёт на оплату");
  });

  test("распознанный текст вложения сохраняется в базу", async () => {
    const email = makeEmail();
    const file = makeAttachmentFile();
    const att = insertAttachment({
      emailId: email.id,
      filename: "скан.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: file,
      extractedText: null,
      contentId: null,
      kind: "document",
      handled: true
    });
    mockPrepare.mockResolvedValue(prepared({ filename: "скан.pdf", extractedText: "", images: ["data:image/png;base64,AAA"] }));
    mockOcr.mockResolvedValue("распознанный текст");
    mockAnalyze.mockResolvedValue(ok());

    await runAnalysis(email.id);

    expect(listAttachments(email.id).find((a) => a.id === att.id)!.extractedText).toContain("распознанный текст");
  });
});

describe("отказы и прерывание", () => {
  test("несуществующее письмо не роняет анализ", async () => {
    await expect(runAnalysis(randomUUID())).resolves.toBeNull();
  });

  test("ошибка модели переводит письмо в «Ошибка»", async () => {
    const email = makeEmail();
    mockAnalyze.mockRejectedValue(new Error("модель недоступна"));

    await expect(runAnalysis(email.id)).resolves.toBeNull();
    expect(getEmail(email.id)!.analysisStatus).toBe("error");
  });

  test("ошибка OCR не срывает анализ — текст документа всё равно уходит в модель", async () => {
    const email = makeEmail();
    const file = makeAttachmentFile();
    insertAttachment({
      emailId: email.id,
      filename: "скан.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: file,
      extractedText: null,
      contentId: null,
      kind: "document",
      handled: true
    });
    mockPrepare.mockResolvedValue(prepared({ extractedText: "текст слоя", images: ["data:image/png;base64,AAA"] }));
    mockOcr.mockRejectedValue(new Error("OCR недоступен"));
    mockAnalyze.mockResolvedValue(ok());

    await runAnalysis(email.id);

    expect(getEmail(email.id)!.analysisStatus).toBe("ready");
    expect(mockAnalyze.mock.calls[0][1].attachmentTexts.join(" ")).toContain("текст слоя");
  });

  test("письмо, удалённое во время анализа, не сохраняет результат", async () => {
    const email = makeEmail();
    mockAnalyze.mockImplementation(async () => {
      // Пользователь удалил письмо, пока модель думала.
      deleteEmails([email.id]);
      return ok({ summary: "устаревшее" });
    });

    await expect(runAnalysis(email.id)).resolves.toBeNull();
    expect(getEmail(email.id)).toBeNull();
  });

  test("остановка анализа возвращает письмо в «Ожидает»", async () => {
    const email = makeEmail();
    mockAnalyze.mockImplementation(async () => {
      stopAnalysis(); // пользователь нажал «Стоп»
      const err = new Error("aborted");
      throw err;
    });

    await runAnalysis(email.id);
    // Прерванный анализ возвращает письмо в очередь, а не помечает ошибкой.
    expect(getEmail(email.id)!.analysisStatus).toBe("pending");
  });
});

describe("очередь", () => {
  test("постановка в очередь помечает письмо и увеличивает очередь", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok());

    enqueue(email.id);
    expect(getEmail(email.id)!.analysisStatus).toBe("queued");
    expect(queueLength()).toBeGreaterThan(0);

    await drain();
    expect(getEmail(email.id)!.analysisStatus).toBe("ready");
  });

  test("повторная постановка того же письма не дублируется", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok());

    enqueue(email.id);
    enqueue(email.id);
    await drain();

    expect(mockAnalyze).toHaveBeenCalledTimes(1);
  });

  test("остановка снимает письма из очереди", async () => {
    const ids = [makeEmail().id, makeEmail().id, makeEmail().id];
    mockAnalyze.mockResolvedValue(ok());
    ids.forEach((id) => enqueue(id));

    const cleared = stopAnalysis();
    expect(cleared).toBeGreaterThanOrEqual(1);
    // queueLength включает и выполняющуюся задачу, поэтому дожидаемся её завершения.
    await drain();
    expect(queueLength()).toBe(0);
  });

  test("снятие с учёта позволяет поставить письмо заново", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok());
    enqueue(email.id);
    cancelAnalysis([email.id]);
    await drain();

    enqueue(email.id);
    await drain();
    expect(mockAnalyze.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("прогресс доступен и после остановки не зависает", async () => {
    const p = getProgress();
    expect(p.stage).toBe("idle");
    expect(p.queueLength).toBe(0);
  });
});

describe("массовые запуски", () => {
  test("analyzeAllPending берёт письма без готового результата", async () => {
    const email = makeEmail();
    mockAnalyze.mockResolvedValue(ok());
    const n = analyzeAllPending();
    expect(n).toBeGreaterThanOrEqual(1);
    await drain();
    expect(getEmail(email.id)!.analysisStatus).toBe("ready");
  });

  test("analyzeEmails возвращает число поставленных писем", async () => {
    const ids = [makeEmail().id, makeEmail().id];
    mockAnalyze.mockResolvedValue(ok());
    expect(analyzeEmails(ids)).toBe(2);
    await drain();
  });

  test("analyzeRange фильтрует по датам", async () => {
    makeEmail({ date: "2020-05-05T10:00:00.000Z" });
    mockAnalyze.mockResolvedValue(ok());
    const n = analyzeRange("2026-01-01", "2026-12-31");
    const inRange = listEmails().filter((e) => (e.date ?? "").slice(0, 10) >= "2026-01-01");
    expect(n).toBe(inRange.length);
    await drain();
  });

  test("analyzeRange по чужому аккаунту ничего не берёт", async () => {
    expect(analyzeRange(undefined, undefined, ["нет-такого-аккаунта"])).toBe(0);
  });
});
