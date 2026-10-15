import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Ручной скан ящика (T30): счётчик `knownOutOfRange` обязан доходить до клиента.
 *
 * Именно он делает наблюдаемым «тело письма вне диапазона повторно НЕ скачивается»: по времени
 * на локальном стенде этого не увидеть (4 МБ уходят за 0,1 с), а по счётчику — видно.
 */
const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

// Ручной скан ящика — операция над СВОИМ ящиком: граница по владельцу, права роли не нужны.
const TOKEN = "token:admin";
let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(TOKEN, testUser("u-admin", ["admin"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ручной скан ящика: результат и счётчики", () => {
  test("счётчик knownOutOfRange доходит до клиента без изменений", async () => {
    coreMocks.fetchEmails.mockResolvedValueOnce({ added: 0, skipped: 7, knownOutOfRange: 7 });

    const res = await request(app.baseUrl, "POST", "/api/accounts/acc-1/fetch", {
      token: TOKEN,
      body: { since: "2026-10-01" }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 0, skipped: 7, knownOutOfRange: 7 });
  });

  test("диапазон и режим ручного скана уходят в ядро как есть", async () => {
    await request(app.baseUrl, "POST", "/api/accounts/acc-1/fetch", {
      token: TOKEN,
      body: { since: "2026-10-01", until: "2026-10-07" }
    });

    expect(coreMocks.fetchEmails).toHaveBeenCalledWith("acc-1", {
      since: "2026-10-01",
      until: "2026-10-07",
      includeDeleted: true
    });
  });

  test("без диапазона поля не подставляются", async () => {
    await request(app.baseUrl, "POST", "/api/accounts/acc-1/fetch", { token: TOKEN, body: {} });

    expect(coreMocks.fetchEmails).toHaveBeenCalledWith("acc-1", {
      since: undefined,
      until: undefined,
      includeDeleted: true
    });
  });
});
