import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Служебный доступ к агрегату «профиль исполнителя» (task-18).
 *
 * Агрегат читает ТОЛЬКО администратор (settings.manage): это производные данные о людях,
 * и никаких рассылок из него не делается. Здесь проверяется доступ, честность ответа
 * пересчёта и то, что автотриггер после закрытия поручения не ломает ответ маршрута.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, unknown>;
};

const token = (role: string) => "token:" + role;

let expressApp: express.Express;
let app: RunningApp;
/**
 * Провайдер регистрируется при СБОРКЕ приложения, а beforeEach чистит записи вызовов —
 * поэтому держим саму функцию, а не смотрим в мок после очистки.
 */
let mailFactsProvider: ((ids: string[]) => Map<string, { tags: string[]; categories: string[] }>) | undefined;

const detail = (patch: Record<string, unknown> = {}) => ({
  id: "res-1",
  documentId: "doc-1",
  documentNumber: "вх1",
  text: "Подготовить ответ",
  deadline: null,
  status: "sent",
  preparedBy: "u-secretary",
  approvedBy: "u-signer",
  confirmedBy: null,
  dispatchedBy: null,
  assignees: [{ userId: "u-executor", fullName: "Исполнитель", email: "e@stand.test", kind: "responsible" }],
  ...patch
});

beforeAll(async () => {
  for (const role of ["admin", "secretary", "manager", "signer", "executor", "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  expressApp = await createApp({});
  mailFactsProvider = mockedDocflow.setUserStatsMailFactsProvider.mock.calls[0]?.[0] as typeof mailFactsProvider;
  app = await listen(expressApp);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedDocflow.listUserActivityStats.mockResolvedValue({ items: [], total: 0, computedAt: null });
  mockedDocflow.recomputeUserStats.mockResolvedValue({ users: 0, updated: 0, skipped: 0, monthly: 0 });
  mockedDocflow.getResolutionDetail.mockResolvedValue(detail());
  mockedDocflow.getResolution.mockResolvedValue({ id: "res-1", status: "sent" });
  mockedDocflow.closeResolution.mockResolvedValue({ id: "res-1", status: "done" });
  mockedDocflow.reportExecution.mockResolvedValue({ id: "res-1", status: "done" });
  mockedDocflow.confirmReport.mockResolvedValue({ id: "res-1", status: "done" });
});

describe("доступ к агрегату: только администратор", () => {
  test("GET /api/docflow/stats — администратор видит агрегат, исполнитель получает 403", async () => {
    const admin = await request(app.baseUrl, "GET", "/api/docflow/stats", { token: token("admin") });
    const executor = await request(app.baseUrl, "GET", "/api/docflow/stats", { token: token("executor") });
    const anonymous = await request(app.baseUrl, "GET", "/api/docflow/stats");

    expect([admin.status, executor.status, anonymous.status]).toEqual([200, 403, 401]);
    expect(admin.body).toMatchObject({ items: [], total: 0, computedAt: null });
    expect(mockedDocflow.listUserActivityStats).toHaveBeenCalledTimes(1);
  });

  test("GET отдаёт агрегат за конкретного пользователя, если он указан", async () => {
    await request(app.baseUrl, "GET", "/api/docflow/stats?userId=u-executor&limit=5", {
      token: token("admin")
    });
    expect(mockedDocflow.listUserActivityStats).toHaveBeenCalledWith({ userId: "u-executor", limit: 5 });
  });

  test("POST /recompute — администратор запускает пересчёт, исполнитель получает 403", async () => {
    mockedDocflow.recomputeUserStats.mockResolvedValueOnce({ users: 3, updated: 2, skipped: 1, monthly: 4 });

    const admin = await request(app.baseUrl, "POST", "/api/docflow/stats/recompute", {
      token: token("admin"),
      body: { userIds: ["u-1", "u-2"] }
    });
    const executor = await request(app.baseUrl, "POST", "/api/docflow/stats/recompute", {
      token: token("executor"),
      body: {}
    });

    expect(admin.status).toBe(200);
    // Ответ честный: сколько пересчитано и сколько пропущено по отпечатку.
    expect(admin.body).toEqual({ users: 3, updated: 2, skipped: 1, monthly: 4 });
    expect(mockedDocflow.recomputeUserStats).toHaveBeenCalledWith({ userIds: ["u-1", "u-2"] });
    expect(executor.status).toBe(403);
  });

  test("POST /recompute без списка пересчитывает всех активных", async () => {
    await request(app.baseUrl, "POST", "/api/docflow/stats/recompute", { token: token("admin"), body: {} });
    expect(mockedDocflow.recomputeUserStats).toHaveBeenCalledWith({});
  });

  test("мусор в userIds — 400, пересчёт не запускается", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/stats/recompute", {
      token: token("admin"),
      body: { userIds: "не список" }
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_user_ids" });
    expect(mockedDocflow.recomputeUserStats).not.toHaveBeenCalled();
  });
});

describe("провайдер фактов почты: теги и категории из анализа писем", () => {
  test("провайдер зарегистрирован и переводит анализ письма в теги/категории", async () => {
    expect(typeof mailFactsProvider).toBe("function");
    const provider = mailFactsProvider!;

    mockedCore.getAnalysis.mockImplementation((id: string) =>
      id === "e-1" ? { tags: ["договор"], category: "work" } : null
    );

    const facts = provider(["e-1", "e-2"]);
    expect(facts.get("e-1")).toEqual({ tags: ["договор"], categories: ["work"] });
    // Письма без анализа просто не попадают в карту — пересчёт это переживёт.
    expect(facts.has("e-2")).toBe(false);
  });

  test("сбой анализа одного письма не роняет весь пересчёт", async () => {
    const provider = mailFactsProvider!;

    mockedCore.getAnalysis.mockImplementation((id: string) => {
      if (id === "e-bad") throw new Error("почтовая база недоступна");
      return { tags: ["ок"], category: "personal" };
    });

    const facts = provider(["e-bad", "e-ok"]);
    expect(facts.has("e-ok")).toBe(true);
    expect(facts.get("e-ok")).toEqual({ tags: ["ок"], categories: ["personal"] });
  });
});

describe("закрытие поручения запускает пересчёт, но не зависит от него", () => {
  test("после закрытия агрегат пересчитывается по участникам поручения", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/close", {
      token: token("secretary"),
      body: { comment: "исполнено лично" }
    });
    expect(res.status).toBe(200);

    // fire-and-forget: даём микротаскам выполниться, ответ уже отдан.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedDocflow.recomputeUserStats).toHaveBeenCalledTimes(1);
    const called = mockedDocflow.recomputeUserStats.mock.calls[0][0] as { userIds: string[] };
    expect([...called.userIds].sort()).toEqual(["u-executor", "u-secretary", "u-signer"]);
  });

  test("сбой пересчёта не ломает ответ закрытия", async () => {
    mockedDocflow.recomputeUserStats.mockRejectedValueOnce(new Error("БД недоступна"));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/close", {
      token: token("secretary"),
      body: { comment: "исполнено лично" }
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(res.status).toBe(200);
  });

  test("пока поручение не закрыто, пересчёт не запускается", async () => {
    mockedDocflow.closeResolution.mockResolvedValueOnce({ id: "res-1", status: "sent" });

    await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/close", {
      token: token("secretary"),
      body: { comment: "ещё не закрыто" }
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(mockedDocflow.recomputeUserStats).not.toHaveBeenCalled();
  });
});
