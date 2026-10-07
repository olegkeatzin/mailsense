import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Центр уведомлений и правила автосортировки (§6 контракта, приложение А).
 *
 * Проверяем поведение снаружи — кодами и телом ответа:
 *   • чужое уведомление → 404 (не 403: 403 выдаёт существование записи);
 *   • правила не создают документ и не трогают нумерацию;
 *   • ни один маршрут не отправляет письма (А8, Р11).
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, unknown>;
};

const token = (role: string) => "token:" + role;
const emptyMatch = { matched: false, labels: [], notes: [], priority: null, ruleIds: [] };

const mail = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  accountId: "acc-1",
  folder: "INBOX",
  subject: "Письмо " + id,
  from: { name: "АО Поставщик", address: id + "@stand.test" },
  to: [{ name: "Аппарат", address: "office@stand.test" }],
  date: "2026-10-01T10:00:00.000Z",
  analysisStatus: "done",
  externalNumber: null,
  sendDate: null,
  analysis: null,
  ...patch
});

let expressApp: express.Express;
let app: RunningApp;

beforeAll(async () => {
  for (const role of ["admin", "secretary", "manager", "signer", "executor", "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  expressApp = await createApp({});
  app = await listen(expressApp);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedCore.listEmailsWithAnalysis.mockReturnValue([]);
  mockedCore.countAttachmentsByEmail.mockReturnValue(new Map());
  mockedCore.matchSortRules.mockReturnValue(emptyMatch);
  mockedDocflow.listRegisteredEmailIds.mockResolvedValue([]);
  mockedDocflow.listSortRules.mockResolvedValue([]);
});

describe("своё уведомление открывается, чужое — нет", () => {
  test("чужая запись даёт 404 и НЕ помечается прочитанной", async () => {
    mockedDocflow.markNotificationRead.mockResolvedValueOnce(null);

    const res = await request(app.baseUrl, "POST", "/api/docflow/notifications/n-чужое/read", {
      token: token("executor")
    });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_found" });
    // Запрос ушёл с идентификатором пользователя сессии: фильтр по владельцу — на сервере.
    expect(mockedDocflow.markNotificationRead).toHaveBeenCalledWith("n-чужое", "u-executor");
  });

  test("своё уведомление помечается прочитанным и отдаёт счётчик", async () => {
    mockedDocflow.markNotificationRead.mockResolvedValueOnce({ ok: true, unread: 2 });

    const res = await request(app.baseUrl, "POST", "/api/docflow/notifications/n-1/read", {
      token: token("executor")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, unread: 2 });
  });

  test("read-all возвращает число фактически обновлённых строк", async () => {
    mockedDocflow.markAllNotificationsRead.mockResolvedValueOnce(3);

    const res = await request(app.baseUrl, "POST", "/api/docflow/notifications/read-all", {
      token: token("manager")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3, unread: 0 });
    expect(mockedDocflow.markAllNotificationsRead).toHaveBeenCalledWith("u-manager");
  });
});

describe("чтение уведомлений", () => {
  test("список отдаёт форму §6 и признак enabled (А4)", async () => {
    mockedDocflow.listNotifications.mockResolvedValueOnce({
      items: [
        {
          id: "n-1",
          kind: "resolution.assigned",
          entityType: "resolution",
          entityId: "res-1",
          title: "Новое поручение вх1",
          body: "Вам поручено",
          severity: "info",
          createdAt: "2026-10-07T10:00:00.000Z",
          readAt: null,
          deadline: "2026-11-01",
          daysLeft: 25,
          link: "tasks"
        }
      ],
      unread: 1,
      total: 1,
      enabled: true
    });

    const res = await request(app.baseUrl, "GET", "/api/docflow/notifications?limit=10", {
      token: token("executor")
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unread: 1, total: 1, enabled: true });
    expect((res.body as { items: Array<{ link: string }> }).items[0].link).toBe("tasks");
    expect(mockedDocflow.listNotifications).toHaveBeenCalledWith("u-executor", {
      limit: 10,
      unreadOnly: false
    });
  });

  test("unread=1 отдаёт только непрочитанные: параметр доходит до хранилища", async () => {
    await request(app.baseUrl, "GET", "/api/docflow/notifications?unread=1", { token: token("signer") });
    expect(mockedDocflow.listNotifications).toHaveBeenCalledWith("u-signer", {
      limit: 50,
      unreadOnly: true
    });
  });

  test("счётчик для бейджа дёшев и отдаёт enabled (А4)", async () => {
    mockedDocflow.countUnreadNotifications.mockResolvedValueOnce(7);

    const res = await request(app.baseUrl, "GET", "/api/docflow/notifications/count", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 7, enabled: true });
  });

  test("чтение материализует сроки: иначе бейдж не показал бы просрочку", async () => {
    await request(app.baseUrl, "GET", "/api/docflow/notifications/count", { token: token("executor") });
    expect(mockedDocflow.materializeDeadlineNotificationsSafe).toHaveBeenCalledWith("u-executor");

    await request(app.baseUrl, "GET", "/api/docflow/notifications", { token: token("executor") });
    expect(mockedDocflow.materializeDeadlineNotificationsSafe).toHaveBeenCalledTimes(2);
  });
});

describe("настройки уведомлений: мусор не проходит и не пишется", () => {
  test("чужая роль до настроек не доходит (право settings.manage)", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/notifications/settings", {
      token: token("executor")
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.getNotificationSettings).not.toHaveBeenCalled();
  });

  test("тело с мусором → 400 и ни одной записи", async () => {
    const bad = [
      { dueSoonDays: "завтра" },
      { dueSoonDays: 3.5 },
      { enabled: "да" },
      { workdayDeadlines: "может быть" },
      { holidays: "2026-05-09" },
      { templates: "не список" }
    ];
    for (const body of bad) {
      const res = await request(app.baseUrl, "PUT", "/api/docflow/notifications/settings", {
        token: token("admin"),
        body
      });
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(mockedDocflow.saveNotificationSettings).not.toHaveBeenCalled();
  });

  test("корректное тело доходит до docflow целиком", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/notifications/settings", {
      token: token("admin"),
      body: {
        enabled: false,
        dueSoonDays: 5,
        workdayDeadlines: false,
        holidays: ["2026-05-09"],
        templates: [{ key: "resolution.assigned", title: "Заголовок", body: "Текст", isActive: true }]
      }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedDocflow.saveNotificationSettings).toHaveBeenCalledWith(
      {
        enabled: false,
        dueSoonDays: 5,
        workdayDeadlines: false,
        holidays: ["2026-05-09"],
        templates: [{ key: "resolution.assigned", title: "Заголовок", body: "Текст", isActive: true }]
      },
      expect.objectContaining({ id: "u-admin" })
    );
  });
});

describe("правила автосортировки", () => {
  test("сервер регистрирует в хранилище проверку правил из ядра: границы §5 действуют для всех", async () => {
    // Регистрация происходит при сборке приложения — проверяем её явно, чтобы снятие
    // одного вызова не осталось незамеченным (иначе границы проверял бы только маршрут).
    await createApp({});
    expect(mockedDocflow.setSortRuleValidator).toHaveBeenCalledWith(mockedCore.validateSortRule);
  });

  test("невалидное правило отклоняется и НЕ сохраняется", async () => {
    mockedCore.validateSortRule.mockReturnValueOnce({ ok: false, errors: ["Укажите хотя бы один матчер"] });

    const res = await request(app.baseUrl, "POST", "/api/docflow/sorting/rules", {
      token: token("admin"),
      body: { name: "Пустое правило", matchFrom: "", matchTo: "", matchSubject: "" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_rule" });
    expect(String((res.body as { error: string }).error)).toContain("матчер");
    expect(mockedDocflow.saveSortRule).not.toHaveBeenCalled();
  });

  test("PATCH проверяет ИТОГ правки: снятие последнего матчера не проходит", async () => {
    // В базе правило с матчером; PATCH присылает только matchFrom: "".
    mockedDocflow.getSortRule.mockResolvedValueOnce({
      id: "r-1",
      name: "Правило",
      isActive: true,
      sortOrder: 0,
      matchFrom: "поставщик",
      matchTo: "",
      matchSubject: "",
      label: "",
      priority: null,
      note: ""
    });
    mockedCore.validateSortRule.mockReturnValueOnce({ ok: false, errors: ["Правило без матчеров"] });

    const res = await request(app.baseUrl, "PATCH", "/api/docflow/sorting/rules/r-1", {
      token: token("admin"),
      body: { matchFrom: "" }
    });

    expect(res.status).toBe(400);
    expect(mockedDocflow.saveSortRule).not.toHaveBeenCalled();
    // Проверялся именно итог: в правиле остались поля из базы.
    expect(mockedCore.validateSortRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r-1", matchFrom: "", matchSubject: "" })
    );
  });

  test("предпросмотр считает совпадения и ничего не записывает", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValueOnce([mail("e-1"), mail("e-2")]);
    mockedCore.matchSortRules
      .mockReturnValueOnce({ matched: true, labels: ["Поставщик"], notes: ["Проверить срок"], priority: 4, ruleIds: ["preview"] })
      .mockReturnValueOnce(emptyMatch);

    const res = await request(app.baseUrl, "POST", "/api/docflow/sorting/rules/preview", {
      token: token("admin"),
      body: { name: "От поставщика", matchFrom: "поставщик" }
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: 1, total: 2 });
    expect((res.body as { samples: Array<{ emailId: string; labels: string[] }> }).samples[0]).toMatchObject({
      emailId: "e-1",
      labels: ["Поставщик"]
    });
    // Предпросмотр ничего не пишет и НЕ регистрирует документ.
    expect(mockedDocflow.saveSortRule).not.toHaveBeenCalled();
    expect(mockedDocflow.registerDocument).not.toHaveBeenCalled();
  });

  test("удаление несуществующего правила — 404", async () => {
    mockedDocflow.deleteSortRule.mockResolvedValueOnce(false);
    const res = await request(app.baseUrl, "DELETE", "/api/docflow/sorting/rules/нет-такого", {
      token: token("admin")
    });
    expect(res.status).toBe(404);
  });

  test("типовые сроки доступны поручающим: дата считается ядром (А9)", async () => {
    mockedCore.addWorkingDays.mockReturnValueOnce("2026-05-14");

    const res = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=2026-05-12", {
      token: token("manager")
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workdayDeadlines: true, items: [{ id: "wd-3", dueDate: "2026-05-14" }] });
    expect(mockedCore.addWorkingDays).toHaveBeenCalledWith("2026-05-12", 3, []);
  });

  test("кривая дата отсчёта отклоняется, расчёт не запускается", async () => {
    mockedCore.isWorkingDay.mockImplementationOnce(() => {
      throw new RangeError("нет такой даты");
    });

    const res = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=2026-02-30", {
      token: token("secretary")
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_from" });
    expect(mockedCore.addWorkingDays).not.toHaveBeenCalled();
  });
});

describe("«Входящие на регистрацию»: правила применяет core, регистрацию не делают", () => {
  test("sort*-поля добавлены, матчинг вызван один раз на письмо", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValueOnce([mail("e-1"), mail("e-2"), mail("e-3")]);
    mockedCore.matchSortRules.mockImplementation((_rules: unknown, input: { subject?: string }) => {
      if (input.subject === "Письмо e-2") {
        return { matched: true, labels: ["Важное"], notes: ["Подсказка"], priority: 5, ruleIds: ["r-1"] };
      }
      return emptyMatch;
    });

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    const important = items.find((i) => i.emailId === "e-2");
    expect(important).toMatchObject({
      sortLabels: ["Важное"],
      sortNotes: ["Подсказка"],
      sortPriority: 5,
      sortMatched: true
    });
    // Ни одной второй реализации матчинга: ровно один вызов на письмо.
    expect(mockedCore.matchSortRules).toHaveBeenCalledTimes(3);
    // Правило не создаёт документ: регистрация — только через journal.register.
    expect(mockedDocflow.registerDocument).not.toHaveBeenCalled();
  });

  test("rulesOnly=1 оставляет только совпавшие, total честный", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValueOnce([mail("e-1"), mail("e-2")]);
    mockedCore.matchSortRules.mockImplementation((_rules: unknown, input: { subject?: string }) =>
      input.subject === "Письмо e-2"
        ? { matched: true, labels: ["Важное"], notes: [], priority: 2, ruleIds: ["r-1"] }
        : emptyMatch
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?rulesOnly=1", {
      token: token("secretary")
    });

    expect((res.body as { items: unknown[] }).items).toHaveLength(1);
    expect((res.body as { total: number }).total).toBe(1);
  });

  test("sort=rules поднимает письмо с большим приоритетом, порядок по умолчанию не меняется", async () => {
    // Два запроса к маршруту в одном тесте — список писем должен быть на оба.
    mockedCore.listEmailsWithAnalysis.mockReturnValue([mail("e-1"), mail("e-2")]);
    mockedCore.matchSortRules.mockImplementation((_rules: unknown, input: { subject?: string }) =>
      input.subject === "Письмо e-2"
        ? { matched: true, labels: [], notes: [], priority: 5, ruleIds: ["r-1"] }
        : emptyMatch
    );

    const byRules = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?sort=rules", {
      token: token("secretary")
    });
    expect((byRules.body as { items: Array<{ emailId: string }> }).items.map((i) => i.emailId)).toEqual([
      "e-2",
      "e-1"
    ]);

    const byDate = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming", {
      token: token("secretary")
    });
    expect((byDate.body as { items: Array<{ emailId: string }> }).items.map((i) => i.emailId)).toEqual([
      "e-1",
      "e-2"
    ]);
  });
});

describe("А8: письма-напоминания не отправляются ни одним маршрутом", () => {
  test("полный обход маршрутов этапа 5 не вызывает отправку почты", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValue([mail("e-1")]);
    mockedCore.countAttachmentsByEmail.mockReturnValue(new Map([["e-1", 1]]));
    mockedCore.matchSortRules.mockReturnValue({
      matched: true,
      labels: ["Важное"],
      notes: ["Подсказка"],
      priority: 3,
      ruleIds: ["r-1"]
    });

    const calls: Array<[string, string, unknown]> = [
      ["GET", "/api/docflow/notifications", undefined],
      ["GET", "/api/docflow/notifications/count", undefined],
      ["GET", "/api/docflow/notifications/settings", undefined],
      ["POST", "/api/docflow/notifications/read-all", {}],
      ["POST", "/api/docflow/notifications/n-1/read", {}],
      ["PUT", "/api/docflow/notifications/settings", { dueSoonDays: 4 }],
      ["GET", "/api/docflow/sorting/rules", undefined],
      ["POST", "/api/docflow/sorting/rules", { name: "Правило", matchFrom: "поставщик" }],
      ["POST", "/api/docflow/sorting/rules/preview", { name: "Правило", matchFrom: "поставщик" }],
      ["PATCH", "/api/docflow/sorting/rules/r-1", { note: "уточнение" }],
      ["DELETE", "/api/docflow/sorting/rules/r-1", undefined],
      ["GET", "/api/docflow/deadline-presets?from=2026-05-12", undefined],
      ["GET", "/api/docflow/journal/incoming", undefined]
    ];

    for (const [method, path, body] of calls) {
      const res = await request(app.baseUrl, method, path, { token: token("admin"), body });
      // Создание правила отвечает 201 — это единственное отличие от «просто ок».
      const expected = method === "POST" && path === "/api/docflow/sorting/rules" ? 201 : 200;
      expect([method + " " + path, res.status]).toEqual([method + " " + path, expected]);
    }

    // Р11/А8: уведомления — только внутри приложения. Ни одного письма.
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
  });
});
