import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Выгрузка следов аудита.
 *
 * Система заведена ради вопроса «кто внёс данные неверно». Файл, в котором молча
 * не хватает части следа, хуже отсутствия выгрузки: он выглядит полным, и по нему
 * делают выводы. Поэтому проверяем и полноту, и честность предупреждения.
 */

const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const coreMocks = core as unknown as Record<string, jest.Mock>;

let app: RunningApp;

/**
 * Хранилище следов: listAudit отдаёт не больше 1000 записей за раз (как настоящий
 * репозиторий docflow), поэтому выгрузка обязана ходить страницами.
 */
function auditStore(size: number): void {
  const all = Array.from({ length: size }, (_, i) => ({
    id: "a-" + i,
    userId: "u-1",
    userName: "Аппарат",
    action: "journal.edit",
    entityType: "document",
    entityId: "doc-" + i,
    oldValue: null,
    newValue: null,
    createdAt: "2026-10-05T10:00:00.000Z"
  }));
  mocked.countAudit.mockImplementation(async () => size);
  mocked.listAudit.mockImplementation(async (filter: { limit?: number; offset?: number } = {}) => {
    const offset = filter.offset ?? 0;
    const limit = Math.min(1000, filter.limit ?? 200);
    return all.slice(offset, offset + limit);
  });
}

/** Строки, которые маршрут передал в построитель Excel. */
function exportedRows(): Array<Record<string, unknown>> {
  return coreMocks.buildXlsx.mock.calls[0][0].rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  mocked.__sessions.set("token:executor", testUser("u-executor", ["executor"]));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("выгрузка аудита", () => {
  it("выгружает ВСЕ следы, а не первые 1000", async () => {
    auditStore(2500);

    const res = await request(app.baseUrl, "GET", "/api/audit/export", { token: "token:admin" });

    expect(res.status).toBe(200);
    const rows = exportedRows();
    expect(rows).toHaveLength(2500);
    expect(rows[0].entityId).toBe("doc-0");
    expect(rows[2499].entityId).toBe("doc-2499");

    // Постранично: по 1000, пока страницы не кончатся.
    const offsets = mocked.listAudit.mock.calls.map((call) => (call[0] as { offset?: number }).offset);
    expect(offsets).toEqual([0, 1000, 2000]);

    expect(res.headers.get("x-export-truncated")).toBe("false");
    expect(res.headers.get("x-export-rows")).toBe("2500");
    expect(res.headers.get("x-export-total")).toBe("2500");
  });

  it("фильтр не теряется при постраничной выгрузке", async () => {
    auditStore(1500);

    const res = await request(
      app.baseUrl,
      "GET",
      "/api/audit/export?userId=u-7&dateFrom=2026-01-01&action=journal.edit",
      { token: "token:admin" }
    );

    expect(res.status).toBe(200);
    const filters = mocked.listAudit.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(filters.length).toBeGreaterThan(1);
    for (const filter of filters) {
      expect(filter.userId).toBe("u-7");
      expect(filter.dateFrom).toBe("2026-01-01");
      expect(filter.action).toBe("journal.edit");
    }
    expect(exportedRows()).toHaveLength(1500);
  });

  it("за предохранителем файл честно говорит, что неполный, и сколько пропущено", async () => {
    auditStore(20_500);

    const res = await request(app.baseUrl, "GET", "/api/audit/export", { token: "token:admin" });

    expect(res.status).toBe(200);
    const rows = exportedRows();
    // Первая строка — предупреждение: его видно сразу при открытии файла.
    expect(String(rows[0].createdAt)).toContain("НЕПОЛНАЯ");
    expect(String(rows[0].action)).toContain("20000");
    expect(String(rows[0].action)).toContain("20500");
    expect(rows).toHaveLength(20_001);
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(res.headers.get("x-export-total")).toBe("20500");
  });

  it("пустой аудит — пустой файл без предупреждений", async () => {
    auditStore(0);

    const res = await request(app.baseUrl, "GET", "/api/audit/export", { token: "token:admin" });

    expect(res.status).toBe(200);
    expect(exportedRows()).toHaveLength(0);
    expect(res.headers.get("x-export-truncated")).toBe("false");
  });

  it("выгрузка закрыта правом audit.view", async () => {
    auditStore(10);

    const res = await request(app.baseUrl, "GET", "/api/audit/export", { token: "token:executor" });

    expect(res.status).toBe(403);
    expect(coreMocks.buildXlsx).not.toHaveBeenCalled();
  });
});
