import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";
import { intParam } from "./params.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Числовые параметры запроса.
 *
 * ?limit=abc превращался в LIMIT NaN и уходил в PostgreSQL: вместо понятного отказа
 * клиент получал 500, а в логе — ошибку драйвера. Проверяем не только выгрузку аудита,
 * а все маршруты, где число приходит снаружи и попадает в SQL.
 */

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const mockedCore = core as unknown as Record<string, jest.Mock>;

let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  mockedDocflow.__sessions.set("token:secretary", testUser("u-secretary", ["secretary"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("intParam", () => {
  it("пустое значение — значение по умолчанию", () => {
    expect(intParam(undefined, "limit", { fallback: 200 })).toBe(200);
    expect(intParam("", "limit", { fallback: 200 })).toBe(200);
  });

  it("число в допустимых границах проходит как есть", () => {
    expect(intParam("50", "limit", { fallback: 200, min: 1, max: 1000 })).toBe(50);
  });

  it("значение вне границ приводится к границе, а не уходит в SQL", () => {
    expect(intParam("-5", "limit", { fallback: 200, min: 1, max: 1000 })).toBe(1);
    expect(intParam("100000", "limit", { fallback: 200, min: 1, max: 1000 })).toBe(1000);
  });

  it("мусор и дробное — понятный отказ 400", () => {
    expect(() => intParam("abc", "limit", { fallback: 200 })).toThrow(/limit/);
    expect(() => intParam("2.5", "limit", { fallback: 200 })).toThrow(/целым/);
    expect(() => intParam("1e999", "limit", { fallback: 200 })).toThrow(/целым/);
  });
});

describe("числовые параметры не превращаются в LIMIT NaN", () => {
  const cases: Array<{
    what: string;
    path: string;
    /** Какой параметр указан мусором — его имя обязано быть в тексте отказа. */
    param: string;
    token: string;
    /** Функция слоя данных, до которой запрос дойти не должен. */
    forbidden: jest.Mock;
  }> = [
    { what: "GET /api/audit?limit=abc", path: "/api/audit?limit=abc", param: "limit", token: "token:admin", forbidden: mockedDocflow.listAudit },
    { what: "GET /api/audit?offset=abc", path: "/api/audit?offset=abc", param: "offset", token: "token:admin", forbidden: mockedDocflow.listAudit },
    {
      what: "GET /api/docflow/resolutions?limit=abc",
      path: "/api/docflow/resolutions?limit=abc",
      param: "limit",
      token: "token:secretary",
      forbidden: mockedDocflow.listResolutions
    },
    {
      what: "GET /api/docflow/journal?limit=abc",
      path: "/api/docflow/journal?limit=abc",
      param: "limit",
      token: "token:secretary",
      forbidden: mockedDocflow.listDocuments
    },
    {
      what: "GET /api/docflow/journal/incoming?limit=abc",
      path: "/api/docflow/journal/incoming?limit=abc",
      param: "limit",
      token: "token:secretary",
      forbidden: mockedCore.listEmailsWithAnalysis
    },
    {
      what: "GET /api/contacts/search?limit=abc",
      path: "/api/contacts/search?q=и&limit=abc",
      param: "limit",
      token: "token:admin",
      forbidden: mockedCore.searchDirectory
    }
  ];

  for (const item of cases) {
    it(item.what + " — 400 и без обращения к данным", async () => {
      const res = await request(app.baseUrl, "GET", item.path, { token: item.token });

      expect(res.status).toBe(400);
      expect(String((res.body as { error?: string }).error)).toContain(item.param);
      expect(item.forbidden).not.toHaveBeenCalled();
    });
  }

  it("корректный предел работает как раньше: audit?limit=5&offset=10", async () => {
    const res = await request(app.baseUrl, "GET", "/api/audit?limit=5&offset=10", { token: "token:admin" });

    expect(res.status).toBe(200);
    expect(mockedDocflow.listAudit).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, offset: 10 }));
  });

  it("отрицательный предел приводится к допустимому и не уходит в SQL", async () => {
    const res = await request(app.baseUrl, "GET", "/api/audit?limit=-5&offset=-3", { token: "token:admin" });

    expect(res.status).toBe(200);
    expect(mockedDocflow.listAudit).toHaveBeenCalledWith(expect.objectContaining({ limit: 1, offset: 0 }));
  });

  it("дробный предел отклонён", async () => {
    const res = await request(app.baseUrl, "GET", "/api/audit?limit=2.5", { token: "token:admin" });

    expect(res.status).toBe(400);
    expect(mockedDocflow.listAudit).not.toHaveBeenCalled();
  });
});
