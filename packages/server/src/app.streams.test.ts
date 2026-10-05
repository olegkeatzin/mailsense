import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, sleep, stillAlive, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Отдача вложений потоком.
 *
 * Файл может исчезнуть между проверкой существования и открытием — например, письмо
 * удалили в другом окне. Тогда поток чтения падает, и без обработчика ошибок это
 * необработанное исключение: сервер завершается вместе со всей локальной почтой.
 */

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const coreMocks = core as unknown as Record<string, jest.Mock>;

let dir = "";
let app: RunningApp;

const attachment = (id: string, storagePath: string, mimeType: string, filename: string) => ({
  id,
  emailId: "e-1",
  storagePath,
  mimeType,
  filename,
  size: 0,
  extractedText: null
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-server-"));
  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* на Windows каталог может быть ещё занят */
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("скачивание вложения", () => {
  it("существующий файл отдаётся с типом и именем", async () => {
    const file = path.join(dir, "счёт.pdf");
    fs.writeFileSync(file, Buffer.from("%PDF-1.4 тест"));
    coreMocks.listAttachments.mockReturnValue([attachment("att-1", file, "application/pdf", "счёт.pdf")]);

    const res = await request(app.baseUrl, "GET", "/api/emails/e-1/attachments/att-1/file", {
      token: "token:admin"
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe("%PDF-1.4 тест");
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  }, 10000);

  it("клиент оборвал скачивание — сервер продолжает обслуживать запросы", async () => {
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 7));
    coreMocks.listAttachments.mockReturnValue([
      attachment("att-big", file, "application/octet-stream", "big.bin")
    ]);

    const controller = new AbortController();
    const response = await fetch(app.baseUrl + "/api/emails/e-1/attachments/att-big/file", {
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await sleep(150);

    expect(await stillAlive(app.baseUrl)).toBe(true);
  }, 15000);

  it("файл исчез между проверкой и открытием — 404 и живой процесс", async () => {
    const gone = path.join(dir, "исчез.pdf");
    coreMocks.listAttachments.mockReturnValue([attachment("att-gone", gone, "application/pdf", "исчез.pdf")]);

    // Ровно та гонка: файл был, и вот его уже нет.
    const realExists = fs.existsSync;
    const spy = jest.spyOn(fs, "existsSync").mockImplementation((target: fs.PathLike) =>
      String(target) === gone ? true : realExists(target)
    );

    try {
      const res = await request(app.baseUrl, "GET", "/api/emails/e-1/attachments/att-gone/file", {
        token: "token:admin"
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Файл не найден" });
      expect(await stillAlive(app.baseUrl)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 10000);
});
