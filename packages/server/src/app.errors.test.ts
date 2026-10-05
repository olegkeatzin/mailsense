import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const coreMocks = core as unknown as Record<string, jest.Mock> & {
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
};

let app: RunningApp;

beforeAll(async () => {
  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ошибки наружу не текут", () => {
  it("непредвиденный сбой — 500 с обобщённым текстом, детали только в логе", async () => {
    coreMocks.listEmailsWithAnalysis.mockImplementationOnce(() => {
      throw new Error("ENOENT: не открыть C:\\srv\\secret\\keys.json");
    });

    const res = await request(app.baseUrl, "GET", "/api/emails", { token: "token:admin" });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("secret");
    expect(res.text).not.toContain("ENOENT");
    expect(res.body).toEqual({ error: "Внутренняя ошибка сервера" });

    // А разработчику детали всё же нужны — они в логе.
    const logged = coreMocks.logger.error.mock.calls.map((call) => JSON.stringify(call)).join(" ");
    expect(logged).toContain("ENOENT");
  });

  it("ожидаемый отказ (AppError) доходит до клиента со своим статусом и кодом", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mocked.getDocument.mockImplementationOnce(async () => {
      throw new AppError("Документ не найден", 404, "not_found");
    });

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/doc-1", { token: "token:admin" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Документ не найден", code: "not_found" });
  });

  it("документооборот не настроен — понятная 503, а не пустой экран", async () => {
    mocked.hasDocflowDb.mockReturnValueOnce(false);
    const res = await request(app.baseUrl, "GET", "/api/docflow/journal", { token: "token:admin" });
    expect(res.status).toBe(503);
    expect(String((res.body as { error?: string }).error)).toContain("DOCFLOW_DATABASE_URL");
  });
});

describe("лимит тела запроса", () => {
  const threeMegabytes = 3 * 1024 * 1024;

  it("большое тело на обычном маршруте отклоняется с 413", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/settings", {
      token: "token:admin",
      rawBody: JSON.stringify({ pad: "x".repeat(threeMegabytes) })
    });
    expect(res.status).toBe(413);
  });

  it("битый JSON — 400, а не 500 с дампом парсера", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/settings", {
      token: "token:admin",
      rawBody: "{это не json"
    });
    expect(res.status).toBe(400);
  });

  it("у импорта писем свой, больший лимит: пачка .eml проходит", async () => {
    coreMocks.importEmails.mockResolvedValueOnce({ added: 1, skipped: 0 });
    const res = await request(app.baseUrl, "POST", "/api/import", {
      token: "token:admin",
      rawBody: JSON.stringify({
        accountId: "acc-1",
        folder: "INBOX",
        files: [{ filename: "письмо.eml", data: "AAAA" }],
        pad: "x".repeat(threeMegabytes)
      })
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 1, skipped: 0 });
  });
});
