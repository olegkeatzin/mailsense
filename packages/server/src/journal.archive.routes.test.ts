import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { journalAttachmentStore } from "./journalRoutes.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Архив года: выгрузка потоком и импорт.
 *
 * Главное здесь — не «маршрут отвечает 200», а три вещи, которые легко сделать молча
 * неправильно: архив не должен собираться в памяти, вложения обязаны попасть в выгрузку
 * (без зарегистрированного источника docflow соберёт архив БЕЗ папки attachments и не
 * скажет об этом), а временный файл импорта обязан исчезать и при успехе, и при ошибке.
 */

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const coreMocks = core as unknown as Record<string, jest.Mock>;

let app: RunningApp;
let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-archive-"));
  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  mocked.__sessions.set("token:secretary", testUser("u-secretary", ["secretary"]));
  mocked.__sessions.set("token:executor", testUser("u-executor", ["executor"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог может быть занят */
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("источник вложений зарегистрирован на старте", () => {
  it("без него архив соберётся без вложений — поэтому проверяем сам источник", async () => {
    // Проверяем РЕАЛЬНО зарегистрированный источник, а не запись вызова мока:
    // jest.clearAllMocks() в beforeEach стирает её (регистрация была при createApp),
    // и такая проверка не могла пройти никогда.
    const store = journalAttachmentStore() as {
      list(emailId: string): Promise<Array<{ name: string; open: () => NodeJS.ReadableStream }>>;
    };
    expect(store && typeof store.list).toBe("function");

    const file = path.join(dir, "счёт.pdf");
    fs.writeFileSync(file, "PDF-БАЙТЫ");
    coreMocks.listAttachments.mockReturnValueOnce([
      { id: "att-1", emailId: "e-1", storagePath: file, mimeType: "application/pdf", filename: "счёт.pdf" },
      { id: "att-2", emailId: "e-1", storagePath: null, mimeType: "application/pdf", filename: "потерянный.pdf" }
    ]);

    const list = await store.list("e-1");
    // Вложение без файла в архив не берём: пустышка в архиве хуже отсутствия.
    expect(list.map((a) => a.name)).toEqual(["счёт.pdf"]);

    const chunks: Buffer[] = [];
    for await (const chunk of list[0].open()) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("PDF-БАЙТЫ");
  });
});

describe("GET /api/journal/export", () => {
  it("отдаёт ZIP потоком: первый байт приходит, пока выгрузка ещё идёт", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;

    mocked.exportJournalYear.mockImplementationOnce(async (opts: { year: string; out: NodeJS.WritableStream }) => {
      opts.out.write(Buffer.from("PK\u0003\u0004first"));
      await gate;
      opts.out.write(Buffer.from("tail"));
      opts.out.end();
      finished = true;
      return {
        period: opts.year,
        documents: 0,
        resolutions: 0,
        assignees: 0,
        reports: 0,
        audit: 0,
        attachments: 0,
        files: []
      };
    });

    const res = await fetch(app.baseUrl + "/api/journal/export?year=2026", {
      headers: { authorization: "Bearer token:secretary" }
    });

    expect(res.status).toBe(200);
    expect(String(res.headers.get("content-type"))).toContain("application/zip");
    expect(String(res.headers.get("content-disposition"))).toContain("journal-2026.zip");

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toContain("PK");
    // Клиент уже читает архив, а выгрузка на сервере ещё не закончилась — значит
    // он не собирался в памяти целиком.
    expect(finished).toBe(false);

    release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    expect(finished).toBe(true);
  }, 20000);

  it("год не в формате ГГГГ — 400 до начала ответа", async () => {
    const res = await request(app.baseUrl, "GET", "/api/journal/export?year=26", {
      token: "token:secretary"
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_period" });
    expect(mocked.exportJournalYear).not.toHaveBeenCalled();
  });

  it("без права архивации выгрузки нет", async () => {
    const res = await request(app.baseUrl, "GET", "/api/journal/export?year=2026", {
      token: "token:executor"
    });

    expect(res.status).toBe(403);
    expect(mocked.exportJournalYear).not.toHaveBeenCalled();
  });

  it("обрыв выгрузки после начала ответа не роняет процесс", async () => {
    mocked.exportJournalYear.mockImplementationOnce(async (opts: { out: NodeJS.WritableStream }) => {
      opts.out.write(Buffer.from("PK\u0003\u0004half"));
      throw new Error("база отвалилась на середине");
    });

    await expect(
      fetch(app.baseUrl + "/api/journal/export?year=2026", {
        headers: { authorization: "Bearer token:secretary" }
      }).then((res) => res.text())
    ).rejects.toThrow();

    const alive = await request(app.baseUrl, "GET", "/api/health");
    expect(alive.status).toBe(200);
  }, 20000);
});

describe("POST /api/journal/import", () => {
  const zip = (body: string) => ({ rawBody: body, headers: { "content-type": "application/zip" } });

  it("автор доходит до аудита, временный файл удаляется после успеха", async () => {
    let tempFile = "";
    mocked.importJournalArchive.mockImplementationOnce(
      async (opts: { file: string; actor: { id: string; name: string } }) => {
        tempFile = opts.file;
        // Тело запроса реально записано в файл: docflow читает архив с диска.
        expect(fs.readFileSync(opts.file).toString()).toBe("PK-АРХИВ");
        expect(opts.actor).toEqual({ id: "u-secretary", name: expect.any(String) });
        return { period: "2026", inserted: { documents: 3 }, skipped: {}, attachments: 1 };
      }
    );

    const res = await request(app.baseUrl, "POST", "/api/journal/import", {
      token: "token:secretary",
      ...zip("PK-АРХИВ")
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ period: "2026", inserted: { documents: 3 }, attachments: 1 });
    expect(tempFile).not.toBe("");
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it("битый архив — понятный 400, не 500, и временный файл тоже убран", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    let tempFile = "";
    mocked.importJournalArchive.mockImplementationOnce(async (opts: { file: string }) => {
      tempFile = opts.file;
      throw new AppError("Файл не читается как ZIP-архив журнала", 400, "bad_archive");
    });

    const res = await request(app.baseUrl, "POST", "/api/journal/import", {
      token: "token:secretary",
      ...zip("это не zip")
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_archive" });
    expect(String((res.body as { error?: string }).error)).toContain("ZIP");
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it("чужой formatVersion объясняется, а не прячется за 500", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mocked.importJournalArchive.mockRejectedValueOnce(
      new AppError("Архив формата 99, эта версия понимает 1 — обновите программу", 400, "bad_format")
    );

    const res = await request(app.baseUrl, "POST", "/api/journal/import", {
      token: "token:secretary",
      ...zip("PK-АРХИВ")
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_format" });
    expect(String((res.body as { error?: string }).error)).toContain("формата 99");
  });

  it("импорт без права архивации отклонён", async () => {
    const res = await request(app.baseUrl, "POST", "/api/journal/import", {
      token: "token:executor",
      ...zip("PK-АРХИВ")
    });

    expect(res.status).toBe(403);
    expect(mocked.importJournalArchive).not.toHaveBeenCalled();
  });
});
