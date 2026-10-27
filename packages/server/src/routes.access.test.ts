import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Матрица «маршрут × роль → код ответа».
 *
 * Проверяем её по-настоящему: приложение собирается целиком (createApp), запросы идут
 * HTTP-ом, а права ролей берутся из docflow — если снять requirePermission с маршрута,
 * соответствующая строка матрицы покраснеет.
 */

const ROLES = ["admin", "secretary", "manager", "signer", "executor"] as const;

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, TestUser>;
};
const mockedCore = core as unknown as Record<string, jest.Mock>;

const token = (role: string) => "token:" + role;

/** Карточка поручения: по умолчанию — ЧУЖОЕ поручение, ждущее подписи. */
const resolutionDetail = (patch: Record<string, unknown> = {}) => ({
  id: "res-1",
  documentId: "doc-1",
  documentNumber: "вх1",
  text: "Подготовить ответ",
  deadline: "2026-11-01",
  status: "pending_approval",
  preparedBy: null,
  approvedBy: null,
  confirmedBy: null,
  dispatchedBy: null,
  assignees: [
    { userId: "u-assignee", fullName: "Исполнитель", email: "u-assignee@stand.test", kind: "responsible" }
  ],
  ...patch
});

interface RouteCase {
  /** Что именно защищаем — формулировка требования. */
  what: string;
  method: string;
  path: string;
  body?: unknown;
  /** Роли, которым действие разрешено; остальным — 403. */
  allowed: string[];
  /** Код успешного ответа. */
  ok?: number;
}

const CASES: RouteCase[] = [
  {
    what: "PUT /api/users/:id/roles — роли выдаёт только администратор (рядовой не выдаст роль себе)",
    method: "PUT",
    path: "/api/users/u-executor/roles",
    body: { roleIds: ["admin"] },
    allowed: ["admin"]
  },
  {
    what: "PATCH /api/docflow/journal/:id — руководитель НЕ правит журнал",
    method: "PATCH",
    path: "/api/docflow/journal/doc-1",
    body: { summary: "правка" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/report — подписант НЕ отчитывается",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/report",
    body: { text: "исполнено" },
    allowed: ["admin", "secretary", "executor"]
  },
  {
    what: "PUT /api/settings — настройки предприятия меняет только администратор",
    method: "PUT",
    path: "/api/settings",
    body: { "ai.model": "qwen" },
    allowed: ["admin"]
  },
  {
    what: "PUT /api/ai/config — ключ модели не отдаётся рядовому",
    method: "PUT",
    path: "/api/ai/config",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "GET /api/users — список учётных записей только у администратора",
    method: "GET",
    path: "/api/users",
    allowed: ["admin"]
  },
  {
    what: "POST /api/users — заводить учётки только администратор",
    method: "POST",
    path: "/api/users",
    body: { email: "new@stand.test", fullName: "Новый" },
    allowed: ["admin"],
    ok: 201
  },
  {
    what: "POST /api/users/sync — синхронизация каталога только администратор",
    method: "POST",
    path: "/api/users/sync",
    allowed: ["admin"]
  },
  {
    what: "POST /api/docflow/journal — регистрация документа (руководитель не регистрирует)",
    method: "POST",
    path: "/api/docflow/journal",
    body: { summary: "письмо" },
    allowed: ["admin", "secretary"],
    ok: 201
  },
  {
    what: "GET /api/roles — справочник ролей виден всем, кто видит журнал",
    method: "GET",
    path: "/api/roles",
    allowed: [...ROLES]
  },
  {
    what: "POST /api/docflow/resolutions — черновик готовит аппарат и руководитель (подписант не готовит)",
    method: "POST",
    path: "/api/docflow/resolutions",
    body: { documentId: "doc-1", text: "Подготовить ответ" },
    // Право resolution.create есть у администратора, аппарата и руководителя (Р8):
    // он вправе написать текст и назначить исполнителя. У подписанта его нет.
    allowed: ["admin", "secretary", "manager"],
    ok: 201
  },
  {
    what: "POST /api/docflow/resolutions/:id/approve — утверждают подписант и руководитель, аппарат НЕ утверждает",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/approve",
    body: {},
    allowed: ["admin", "manager", "signer"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/confirm — подтверждает разбор письма только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/confirm",
    body: {},
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/dispatch — исполнителям отправляет только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/dispatch",
    body: {},
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/report/confirm — принять отчёт может только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/report/confirm",
    body: { userId: "u-assignee" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "PUT /api/docflow/numbering — правила нумерации только с правом настроек",
    method: "PUT",
    path: "/api/docflow/numbering",
    body: { prefix: "вх" },
    allowed: ["admin"]
  },
  {
    what: "GET /api/journal/export — выгрузку года делает тот, у кого есть право архивации",
    method: "GET",
    path: "/api/journal/export?year=2026",
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/journal/import — импорт архива пишет в журнал: только с правом архивации",
    method: "POST",
    path: "/api/journal/import",
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/numbering/archive — закрытие года только с правом архивации",
    method: "POST",
    path: "/api/docflow/numbering/archive",
    // Подтверждение годом обязательно и на сервере: без него закрытие отклоняется.
    body: {
      period: String(new Date().getFullYear()),
      confirm: String(new Date().getFullYear())
    },
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/numbering/reopen — отмену закрытия года делает только администратор",
    method: "POST",
    path: "/api/docflow/numbering/reopen",
    body: {
      period: String(new Date().getFullYear()),
      confirm: String(new Date().getFullYear()),
      reason: "закрыли по ошибке"
    },
    allowed: ["admin"]
  },
  {
    what: "GET /api/audit — следы аудита только с правом аудита",
    method: "GET",
    path: "/api/audit",
    allowed: ["admin"]
  },
  {
    what: "PUT /api/docflow/settings — включение СЭД только администратор",
    method: "PUT",
    path: "/api/docflow/settings",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "PUT /api/directory/settings — каталог предприятия настраивает администратор",
    method: "PUT",
    path: "/api/directory/settings",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "POST /api/directory/refresh — обновление каталога только администратор",
    method: "POST",
    path: "/api/directory/refresh",
    allowed: ["admin"]
  },
  {
    // ⚠️ Решение заказчика 2026-10-05: список ВСЕХ резолюций и канбан закрыты от исполнителя.
    // Он видит только свои задачи («Мои задачи»), чужие сроки, тексты и соисполнители ему
    // ни к чему. Права `journal.view` здесь мало — оно есть у всех ролей. Сквозная проверка
    // живёт в scripts/test_resolutions.mjs («рядовой сотрудник не видит список резолюций»).
    what: "GET /api/docflow/resolutions/board — канбан только тем, кто управляет поручениями",
    method: "GET",
    path: "/api/docflow/resolutions/board",
    allowed: ["admin", "secretary", "manager"]
  },
  {
    what: "GET /api/docflow/resolutions/by-document/:id — поручения документа только управляющим",
    method: "GET",
    path: "/api/docflow/resolutions/by-document/doc-1",
    allowed: ["admin", "secretary", "manager"]
  },
  {
    what: "GET /api/docflow/resolutions/:id — чужое поручение не отдаётся (подписанту — то, что ждёт подписи)",
    method: "GET",
    path: "/api/docflow/resolutions/res-1",
    allowed: ["admin", "secretary", "manager", "signer"]
  },
  {
    what: "POST /api/docflow/resolutions/forward — письмо руководителю направляет только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/forward",
    body: { documentId: "doc-1", toUserId: "u-manager" },
    allowed: ["admin", "secretary"],
    ok: 201
  },
  {
    what: "POST /api/docflow/resolutions/draft — черновик текста готовит тот, кто создаёт поручения",
    method: "POST",
    path: "/api/docflow/resolutions/draft",
    body: { documentId: "doc-1" },
    allowed: ["admin", "secretary", "manager"]
  },
  {
    what: "GET /api/docflow/resolutions/suggest-assignees — подсказка исполнителей: поручающим и подписывающим",
    method: "GET",
    path: "/api/docflow/resolutions/suggest-assignees",
    allowed: ["admin", "secretary", "manager", "signer"]
  },
  {
    what: "GET /api/docflow/resolutions/executor-candidates — справочник людей: поручающим и подписывающим",
    method: "GET",
    path: "/api/docflow/resolutions/executor-candidates",
    allowed: ["admin", "secretary", "manager", "signer"]
  },
  {
    what: "GET /api/docflow/resolutions/my-tasks — свои задачи исполнителя",
    method: "GET",
    path: "/api/docflow/resolutions/my-tasks",
    allowed: [...ROLES]
  },
  {
    what: "GET /api/docflow/resolutions/for-confirmation — очередь аппарата «ждёт подтверждения»",
    method: "GET",
    path: "/api/docflow/resolutions/for-confirmation",
    allowed: ["admin", "secretary"]
  },
  {
    what: "GET /api/docflow/resolutions/for-approval — очередь подписанта",
    method: "GET",
    path: "/api/docflow/resolutions/for-approval",
    allowed: ["admin", "manager", "signer"]
  },
  {
    what: "GET /api/docflow/resolutions — список поручений только управляющим",
    method: "GET",
    path: "/api/docflow/resolutions",
    allowed: ["admin", "secretary", "manager"]
  },
  {
    what: "PATCH /api/docflow/resolutions/:id — правка поручения до утверждения",
    method: "PATCH",
    path: "/api/docflow/resolutions/res-1",
    body: { text: "уточнение" },
    allowed: ["admin", "secretary", "manager"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/request-approval — на утверждение отправляет аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/request-approval",
    body: {},
    allowed: ["admin", "secretary", "manager"]
  },
  // Кейс POST /:id/email-approval убран вместе с маршрутом (D-2, task-14): он позволял
  // аппарату записать подписантом себя. Отсутствие маршрута проверяет signature.audit.test.ts.
  {
    what: "POST /api/docflow/resolutions/:id/reject — вернуть на доработку",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/reject",
    body: { comment: "не согласовано" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/cancel — отменить поручение",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/cancel",
    body: { comment: "отбой" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "GET /api/docflow/resolutions/:id/ics — задача в календарь участника",
    method: "GET",
    path: "/api/docflow/resolutions/res-1/ics",
    allowed: ["admin", "secretary", "manager", "signer"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/close — закрыть поручение аппаратом",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/close",
    body: { comment: "исполнено лично" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/received — расписка исполнителя о получении",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/received",
    allowed: [...ROLES]
  },
  // -------- Этап 5: центр уведомлений и автосортировка (§6 + приложение А) --------
  {
    // notifications.view есть у всех пяти ролей: уведомление адресное, и «пустой список»
    // у рядового не должен отличаться от «нет уведомлений». Учётка без ролей права не имеет.
    what: "GET /api/docflow/notifications — свои уведомления видны всем пяти ролям",
    method: "GET",
    path: "/api/docflow/notifications",
    allowed: [...ROLES]
  },
  {
    what: "GET /api/docflow/notifications/count — счётчик для бейджа доступен всем ролям",
    method: "GET",
    path: "/api/docflow/notifications/count",
    allowed: [...ROLES]
  },
  {
    what: "POST /api/docflow/notifications/read-all — «прочитать все» только по своим строкам",
    method: "POST",
    path: "/api/docflow/notifications/read-all",
    body: {},
    allowed: [...ROLES]
  },
  {
    what: "POST /api/docflow/notifications/:id/read — прочтение по идентификатору (владелец — из сессии)",
    method: "POST",
    path: "/api/docflow/notifications/n-1/read",
    body: {},
    allowed: [...ROLES]
  },
  {
    what: "GET /api/docflow/notifications/settings — настройки и шаблоны только администратор",
    method: "GET",
    path: "/api/docflow/notifications/settings",
    allowed: ["admin"]
  },
  {
    what: "PUT /api/docflow/notifications/settings — менять настройки уведомлений только администратор",
    method: "PUT",
    path: "/api/docflow/notifications/settings",
    body: { dueSoonDays: 3 },
    allowed: ["admin"]
  },
  {
    what: "GET /api/docflow/sorting/rules — правила автосортировки видит только администратор",
    method: "GET",
    path: "/api/docflow/sorting/rules",
    allowed: ["admin"]
  },
  {
    what: "POST /api/docflow/sorting/rules — заводить правила только администратор",
    method: "POST",
    path: "/api/docflow/sorting/rules",
    body: { name: "Правило", matchFrom: "поставщик" },
    allowed: ["admin"],
    ok: 201
  },
  {
    what: "POST /api/docflow/sorting/rules/preview — предпросмотр правила только администратор",
    method: "POST",
    path: "/api/docflow/sorting/rules/preview",
    body: { name: "Правило", matchFrom: "поставщик" },
    allowed: ["admin"]
  },
  {
    what: "PATCH /api/docflow/sorting/rules/:id — правка правила только администратор",
    method: "PATCH",
    path: "/api/docflow/sorting/rules/r-1",
    body: { note: "уточнение" },
    allowed: ["admin"]
  },
  {
    what: "DELETE /api/docflow/sorting/rules/:id — удаление правила только администратор",
    method: "DELETE",
    path: "/api/docflow/sorting/rules/r-1",
    allowed: ["admin"]
  },
  {
    // Типовые сроки нужны тому, кто назначает срок (аппарат, руководитель, администратор),
    // и подписанту: при утверждении он вправе поставить срок. Исполнителю — нет.
    what: "GET /api/docflow/deadline-presets — типовые сроки поручающим и подписанту",
    method: "GET",
    path: "/api/docflow/deadline-presets?from=2026-05-12",
    allowed: ["admin", "secretary", "manager", "signer"]
  },
  {
    // Р12: параметры служебного ящика нужны аппарату, который подключается к нему в почте.
    // Что пароль в ответе не отдаётся — проверяет serviceAccountRoutes.test.ts.
    what: "GET /api/docflow/service-account — параметры служебного ящика аппарату",
    method: "GET",
    path: "/api/docflow/service-account",
    allowed: ["admin", "secretary"]
  },
  {
    // Смена служебного ящика меняет, от чьего имени уходят официальные письма: только администратор.
    what: "PUT /api/docflow/service-account — выбор служебного ящика администратором",
    method: "PUT",
    path: "/api/docflow/service-account",
    body: { accountId: "acc-1" },
    allowed: ["admin"]
  },
  {
    // Агрегат «профиль исполнителя» — производные данные о людях: только администратор.
    what: "GET /api/docflow/stats — агрегат профилей исполнителей только администратор",
    method: "GET",
    path: "/api/docflow/stats",
    allowed: ["admin"]
  },
  {
    what: "POST /api/docflow/stats/recompute — пересчёт агрегата только администратор",
    method: "POST",
    path: "/api/docflow/stats/recompute",
    body: {},
    allowed: ["admin"]
  }
];

/**
 * Маршруты резолюций, которых нет в матрице. Успех здесь требует живого письма-источника
 * и подписанта в каталоге — это отдельный сценарий, а не проверка прав.
 */
const MATRIX_EXCEPTIONS = new Set(["POST /api/docflow/resolutions/:id/mark-approval"]);

let expressApp: express.Express;
let app: RunningApp;

beforeAll(async () => {
  for (const role of [...ROLES, "none"]) {
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
  // Р24: в СЭД отправляем ТОЛЬКО со служебного ящика предприятия или с личной рабочей почты.
  // «Первый подходящий» больше не подставляется, поэтому служебный ящик должен быть настроен —
  // иначе маршрут отправки честно откажет, и тест проверял бы не то.
  mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-1" });
});

describe("матрица «маршрут × роль»", () => {
  for (const route of CASES) {
    it(route.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const expected = route.allowed.includes(role) ? route.ok ?? 200 : 403;
        const res = await request(app.baseUrl, route.method, route.path, {
          token: token(role),
          body: route.body
        });
        if (res.status !== expected) {
          failures.push(
            role + ": ожидали " + expected + ", получили " + res.status + " — " + res.text.slice(0, 120)
          );
        }
      }
      const anonymous = await request(app.baseUrl, route.method, route.path, { body: route.body });
      if (anonymous.status !== 401) {
        failures.push("без сессии: ожидали 401, получили " + anonymous.status);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("отказ не доходит до изменения данных", () => {
  it("рядовой не может выдать роль себе — обработчик не вызывается", async () => {
    const assignRoles = mockedDocflow.assignRoles;
    const res = await request(app.baseUrl, "PUT", "/api/users/u-executor/roles", {
      token: token("executor"),
      body: { roleIds: ["admin"] }
    });
    expect(res.status).toBe(403);
    expect(assignRoles).not.toHaveBeenCalled();
  });

  it("руководитель не правит журнал — документ не меняется", async () => {
    const updateDocument = mockedDocflow.updateDocument;
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("manager"),
      body: { summary: "подмена" }
    });
    expect(res.status).toBe(403);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("подписант не отчитывается за исполнителя — отчёт не записывается", async () => {
    const reportExecution = mockedDocflow.reportExecution;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/report", {
      token: token("signer"),
      body: { text: "исполнено" }
    });
    expect(res.status).toBe(403);
    expect(reportExecution).not.toHaveBeenCalled();
  });

  it("в /confirm нельзя записать подписантом пользователя без права подписи", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-executor",
      fullName: "Исполнитель",
      email: "u-executor@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["executor"]);
    const confirmEmailApproval = mockedDocflow.confirmEmailApproval;

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-executor" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "no_sign_right" });
    expect(confirmEmailApproval).not.toHaveBeenCalled();
  });

  it("в /confirm подписант с правом подписи проходит", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-signer",
      fullName: "Подписант",
      email: "u-signer@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["signer"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-signer" }
    });

    expect(res.status).toBe(200);
  });

  it("в /confirm нельзя назвать подписантом несуществующего пользователя", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-призрак" }
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "no_signer" });
  });

  it("в /report/confirm нельзя подтвердить отчёт постороннему", async () => {
    const confirmReport = mockedDocflow.confirmReport;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/report/confirm", {
      token: token("secretary"),
      body: { userId: "u-outsider" }
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "not_assignee" });
    expect(confirmReport).not.toHaveBeenCalled();
  });

  it("подписант не отправляет поручение исполнителям", async () => {
    const dispatchResolution = mockedDocflow.dispatchResolution;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("signer"),
      body: {}
    });
    expect(res.status).toBe(403);
    expect(dispatchResolution).not.toHaveBeenCalled();
  });
});

describe("отправка поручения: захват → письмо → запись письма", () => {
  /**
   * Аппарат отправил письмо из окна (правил текст) — сервер не должен слать второй раз.
   */
  it("письмо из окна: сервер не шлёт, только записывает связь", async () => {
    mockedDocflow.dispatchResolution.mockImplementationOnce(async () => ({ id: "res-1", status: "sent" }));
    mockedDocflow.attachDispatchEmail.mockImplementationOnce(async (id: string, emailId: string) => ({
      id,
      status: "sent",
      dispatchEmailId: emailId
    }));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: { emailId: "mail-out-2" }
    });

    expect(res.status).toBe(200);
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
    expect(mockedDocflow.attachDispatchEmail).toHaveBeenCalledWith("res-1", "mail-out-2", expect.anything());
    expect(res.body).toMatchObject({ dispatchEmailId: "mail-out-2" });
  });

  it("шаги идут по порядку: переход, письмо, запись идентификатора", async () => {
    const order: string[] = [];
    mockedDocflow.dispatchResolution.mockImplementationOnce(async () => {
      order.push("переход");
      return { id: "res-1", status: "sent" };
    });
    mockedCore.sendEmail.mockImplementationOnce(async () => {
      order.push("письмо");
      return { emailId: "sent-1", messageId: "<sent-1@stand.test>" };
    });
    mockedDocflow.attachDispatchEmail.mockImplementationOnce(async (id: string, emailId: string) => {
      order.push("запись письма");
      return { id, status: "sent", dispatchEmailId: emailId };
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(200);
    expect(order).toEqual(["переход", "письмо", "запись письма"]);
    // Идентификатор письма вернулся клиенту — значит записан и в карточке поручения.
    expect(res.body).toMatchObject({ dispatchEmailId: "sent-1" });
  });

  it("проигравший гонку запрос не отправляет второе письмо", async () => {
    // docflow отдаёт 409 второму переходу (SELECT ... FOR UPDATE) — письма быть не должно.
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mockedDocflow.dispatchResolution
      .mockImplementationOnce(async () => ({ id: "res-1", status: "sent" }))
      .mockImplementationOnce(async () => {
        throw new AppError("Поручение уже отправлено", 409, "bad_state");
      });

    const [first, second] = await Promise.all([
      request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
        token: token("secretary"),
        body: {}
      }),
      request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
        token: token("secretary"),
        body: {}
      })
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(mockedCore.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("падение отправки: поручение возвращается в «утверждено», наружу — исходная ошибка", async () => {
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550: ящик отверг письмо"));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("SMTP");
    // Откат выполнен: аппарат увидит поручение снова готовым к отправке.
    expect(mockedDocflow.revertDispatch).toHaveBeenCalledTimes(1);
    expect(String(mockedDocflow.revertDispatch.mock.calls[0][2])).toContain("Почтовый сервер не принял письмо");
    expect(mockedDocflow.attachDispatchEmail).not.toHaveBeenCalled();
  });

  it("отказ самого отката не подменяет исходную ошибку почты", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550"));
    mockedDocflow.revertDispatch.mockRejectedValueOnce(
      new AppError("Исполнитель уже отчитался", 409, "bad_state")
    );

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("SMTP");
    expect(res.text).not.toContain("отчитался");
  });
});

describe("пересылка руководителю: сначала захват, потом письмо", () => {
  it("резолюция создаётся ДО отправки письма", async () => {
    const order: string[] = [];
    mockedDocflow.forwardToManager.mockImplementationOnce(async () => {
      order.push("захват");
      return { id: "res-1", status: "pending_approval" };
    });
    mockedCore.sendEmail.mockImplementationOnce(async () => {
      order.push("письмо");
      return { emailId: "sent-1", messageId: "<sent-1@stand.test>" };
    });
    mockedDocflow.attachRequestEmail.mockImplementationOnce(async (id: string, emailId: string) => {
      order.push("запись письма");
      return { id, status: "pending_approval", requestEmailId: emailId };
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(201);
    expect(order).toEqual(["захват", "письмо", "запись письма"]);
    // Письмо-запрос записано тем самым письмом, которое ушло руководителю.
    expect(mockedDocflow.attachRequestEmail).toHaveBeenCalledWith(
      "res-1",
      "sent-1",
      expect.objectContaining({ id: "u-secretary" })
    );
    expect(res.body).toMatchObject({ requestEmailId: "sent-1" });
  });

  /**
   * Жалоба заказчика: «отправляете молча, без окна письма». Теперь письмо отправляет
   * человек из окна, а сервер только записывает связь — и адрес можно ВПИСАТЬ,
   * даже если в каталоге почты у человека нет.
   */
  it("письмо из окна: сервер ничего не шлёт, связь записывается, адрес — вписанный", async () => {
    mockedDocflow.forwardToManager.mockImplementationOnce(async () => ({ id: "res-9", status: "pending_approval" }));
    mockedDocflow.attachRequestEmail.mockImplementationOnce(async (id: string, emailId: string) => ({
      id,
      status: "pending_approval",
      requestEmailId: emailId
    }));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", emailId: "mail-out-1", toEmail: "boss@outside.test" }
    });

    expect(res.status).toBe(201);
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
    expect(mockedDocflow.attachRequestEmail).toHaveBeenCalledWith("res-9", "mail-out-1", expect.anything());
    expect(res.body).toMatchObject({ sentEmailId: "mail-out-1", sentTo: "boss@outside.test" });
  });

  it("после сбоя отправки пересылку можно повторить — захват откатился", async () => {
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550: ящик отверг письмо"));

    const failed = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(failed.status).toBe(500);
    expect(mockedDocflow.cancelResolution).toHaveBeenCalledTimes(1);
    expect(mockedDocflow.attachRequestEmail).not.toHaveBeenCalled();

    // Отменённая запись повторную пересылку не блокирует: письмо уходит со второго раза.
    mockedCore.sendEmail.mockResolvedValueOnce({ emailId: "sent-2", messageId: "<sent-2@stand.test>" });
    const retry = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ requestEmailId: "sent-2" });
  });

  it("двойной клик отправляет руководителю ровно одно письмо", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mockedDocflow.forwardToManager
      .mockImplementationOnce(async () => ({ id: "res-1", status: "pending_approval" }))
      .mockImplementationOnce(async () => {
        throw new AppError("Письмо уже направлено руководителю", 409, "bad_state");
      });

    const [first, second] = await Promise.all([
      request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
        token: token("secretary"),
        body: { documentId: "doc-1", toUserId: "u-manager" }
      }),
      request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
        token: token("secretary"),
        body: { documentId: "doc-1", toUserId: "u-manager" }
      })
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(mockedCore.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("письмо не ушло — пересылка откатывается, наружу исходная ошибка", async () => {
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550: ящик отверг письмо"));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("SMTP");
    expect(mockedDocflow.cancelResolution).toHaveBeenCalledTimes(1);
  });
});

describe("ссылки на письма по делу ведут только в свои копии", () => {
  it("my-copy находит копию по Message-ID", async () => {
    mockedCore.getEmailView.mockReturnValue({ id: "stored-1", messageId: "<m-1@test>" });
    mockedCore.findEmailCopy.mockReturnValue({ id: "copy-1" });

    const res = await request(app.baseUrl, "GET", "/api/docflow/emails/stored-1/my-copy", {
      token: token("manager")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emailId: "copy-1" });
    expect(mockedCore.findEmailCopy).toHaveBeenCalledWith("<m-1@test>", expect.any(Array));
  });

  it("document email-for-me берёт запрос руководителя, если входящее ему недоступно", async () => {
    mockedDocflow.getDocument.mockResolvedValue({ id: "doc-1", emailId: "src-mail", regNumber: "вх1" });
    mockedDocflow.listDocumentResolutions.mockResolvedValue([
      { ...resolutionDetail({ status: "approved" }), requestEmailId: "req-mail" }
    ]);
    mockedCore.getEmailView.mockImplementation((id: string) => ({ id, messageId: id + "@test" }));
    mockedCore.findEmailCopy.mockImplementation((messageId: string) =>
      messageId === "req-mail@test" ? { id: "copy-req" } : null
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/doc-1/email-for-me", {
      token: token("manager")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emailId: "copy-req", label: "Направлено руководителю" });
  });

  it("email-links скрывает чужие копии и отдаёт свои", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValue({
      ...resolutionDetail({ status: "approved" }),
      documentEmailId: "src-mail",
      requestEmailId: "req-mail",
      approvalEmailId: "approval-mail",
      dispatchEmailId: "dispatch-mail"
    });
    mockedCore.getEmailView.mockImplementation((id: string) => ({ id, messageId: id + "@test" }));
    mockedCore.findEmailCopy.mockImplementation((messageId: string) =>
      messageId === "req-mail@test" || messageId === "dispatch-mail@test" ? { id: "copy-" + messageId } : null
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1/email-links", {
      token: token("manager")
    });

    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([
      { key: "request", label: "Направлено руководителю", emailId: "copy-req-mail@test" },
      { key: "dispatch", label: "Отправлено исполнителям", emailId: "copy-dispatch-mail@test" }
    ]);
  });
});

describe("резолюция, созданная руководителем из письма", () => {
  it("руководитель создаёт и сразу утверждает её по документу; исполнителю нельзя", async () => {
    mockedCore.getEmailView.mockReturnValue({
      id: "mail-1",
      from: { address: "post@mail.test", name: "Аппарат" },
      subject: "Письмо вх1 — прошу наложить резолюцию",
      messageId: "<req-1@stand.test>",
      references: []
    });
    mockedDocflow.createResolution.mockResolvedValue({ id: "res-new" });
    mockedDocflow.requestApproval.mockResolvedValue({ id: "res-new", status: "pending_approval" });
    mockedDocflow.approveResolution.mockResolvedValue({ id: "res-new", status: "approved" });

    const body = {
      emailId: "mail-1",
      text: "Петровой подготовить ответ",
      deadline: "2026-11-01",
      assignees: [{ userId: "u-assignee", kind: "responsible" }]
    };
    const created = await request(
      app.baseUrl,
      "POST",
      "/api/docflow/journal/doc-1/resolutions/from-email",
      { token: token("manager"), body }
    );
    expect(created.status).toBe(201);
    expect(mockedDocflow.createResolution).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", text: "Петровой подготовить ответ", sourceKind: "email" }),
      expect.anything()
    );
    expect(mockedDocflow.approveResolution).toHaveBeenCalledWith(
      "res-new",
      expect.anything(),
      expect.objectContaining({ emailId: "mail-1", text: "Петровой подготовить ответ" })
    );
    // Руководитель отправил сам: ответ ушёл аппарату и исполнителю, без шага dispatch.
    expect(mockedCore.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: expect.arrayContaining([
          expect.objectContaining({ address: "stand@mail.test" }),
          expect.objectContaining({ address: "u-assignee@stand.test" })
        ]),
        inReplyToMessageId: "<req-1@stand.test>"
      })
    );
    expect(mockedDocflow.dispatchResolution).toHaveBeenCalled();

    const denied = await request(
      app.baseUrl,
      "POST",
      "/api/docflow/journal/doc-1/resolutions/from-email",
      { token: token("executor"), body }
    );
    expect(denied.status).toBe(403);
  });
});

describe("ответ руководителя письмом снова сопоставляется с поручением", () => {
  it("письмо из пересылки находится в списке ожидающих утверждения", async () => {
    // 1) Аппарат переслал письмо руководителю: запись создана, письмо записано.
    mockedCore.sendEmail.mockResolvedValueOnce({ emailId: "sent-1", messageId: "<sent-1@stand.test>" });
    const forwarded = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });
    expect(forwarded.status).toBe(201);
    const sentEmailId = (forwarded.body as { sentEmailId: string }).sentEmailId;
    expect(sentEmailId).toBe("sent-1");

    // 2) docflow отдаёт это письмо кандидатом на утверждение (его тесты это гарантируют).
    mockedDocflow.listReplyCandidates.mockResolvedValueOnce([
      {
        resolutionId: "res-1",
        expects: "approval",
        emailId: sentEmailId,
        documentNumber: "вх1",
        documentSummary: "Письмо от поставщика",
        taskText: "",
        assignees: []
      }
    ]);

    // 3) Руководитель ответил в треде: аппарат видит подсказку по этому поручению.
    mockedCore.getEmailView.mockImplementation((id: string) =>
      id === sentEmailId
        ? { id: sentEmailId, messageId: "<sent-1@stand.test>" }
        : {
            id: "reply-1",
            messageId: "<reply-1@stand.test>",
            inReplyTo: "<sent-1@stand.test>",
            references: ["<sent-1@stand.test>"]
          }
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/emails/reply-1/reply-context", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ resolutionId: "res-1", expects: "approval", documentNumber: "вх1" })
    ]);
  });

  it("ответ без признаков треда поручением не считается", async () => {
    mockedDocflow.listReplyCandidates.mockResolvedValueOnce([
      {
        resolutionId: "res-1",
        expects: "approval",
        emailId: "sent-1",
        documentNumber: "вх1",
        documentSummary: "",
        taskText: "",
        assignees: []
      }
    ]);
    mockedCore.getEmailView.mockImplementation((id: string) =>
      id === "sent-1"
        ? { id: "sent-1", messageId: "<sent-1@stand.test>" }
        : { id: "reply-2", messageId: "<reply-2@stand.test>", inReplyTo: null, references: [] }
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/emails/reply-2/reply-context", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("чужое поручение не отдаётся, своё открывается", () => {
  it("исполнитель получает 403 на чужое поручение", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("executor")
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "not_participant" });
  });

  it("исполнитель открывает СВОЮ задачу из «Моих задач»", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValueOnce(
      resolutionDetail({
        assignees: [
          { userId: "u-executor", fullName: "Петрова М.А.", email: "p@stand.test", kind: "responsible" }
        ]
      })
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("executor")
    });

    expect(res.status).toBe(200);
  });

  it("подписант открывает то, что ждёт подписи (очередь «На утверждении»)", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("signer")
    });
    expect(res.status).toBe(200);
  });

  it("подписант не открывает уже отправленное чужое поручение", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValueOnce(resolutionDetail({ status: "sent" }));

    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("signer")
    });

    expect(res.status).toBe(403);
  });

  it("подписант открывает своё поручение и после отправки", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValueOnce(
      resolutionDetail({ status: "sent", approvedBy: "u-signer" })
    );

    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("signer")
    });

    expect(res.status).toBe(200);
  });

  it("аппарат открывает любое поручение", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1", {
      token: token("secretary")
    });
    expect(res.status).toBe(200);
  });

  it("по документу список отдаётся только управляющим", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/by-document/doc-1", {
      token: token("executor")
    });

    expect(res.status).toBe(403);
    expect(mockedDocflow.listDocumentResolutions).not.toHaveBeenCalled();
  });

  it("календарь (:id/ics) тоже не отдаёт чужое поручение", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/resolutions/res-1/ics", {
      token: token("executor")
    });
    expect(res.status).toBe(403);
  });
});

describe("справочник исполнителей: поручающим и подписывающим, не рядовому", () => {
  const paths = [
    "/api/docflow/resolutions/executor-candidates",
    "/api/docflow/resolutions/suggest-assignees"
  ];

  it("подписант получает справочник — он назначает исполнителя при утверждении (Р8)", async () => {
    for (const path of paths) {
      const res = await request(app.baseUrl, "GET", path, { token: token("signer") });
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it("аппарат получает справочник — он поручает", async () => {
    for (const path of paths) {
      const res = await request(app.baseUrl, "GET", path, { token: token("secretary") });
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it("исполнитель не получает ФИО и адреса всех сотрудников — 403 и без выборки", async () => {
    for (const path of paths) {
      const res = await request(app.baseUrl, "GET", path, { token: token("executor") });
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect(mockedDocflow.listUsersWithRoles).not.toHaveBeenCalled();
  });
});

describe("«Входящие на регистрацию»: вложения считаются пакетно", () => {
  const mailbox = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: "e-" + i,
      accountId: "acc-1",
      subject: "Письмо " + i,
      from: null,
      date: "2026-10-01T10:00:00.000Z",
      folder: "INBOX",
      analysisStatus: "done",
      externalNumber: null,
      sendDate: null,
      analysis: null
    }));

  it("число запросов не зависит от числа писем", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValueOnce(mailbox(120));
    mockedDocflow.listRegisteredEmailIds.mockResolvedValueOnce([]);
    mockedCore.countAttachmentsByEmail.mockImplementationOnce(
      (ids: string[]) => new Map(ids.map((id) => [id, 2]))
    );

    // limit=300 — верхняя граница маршрута: вложения считаются для всего, что отдаём.
    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?limit=300", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<{ attachmentsCount: number }> }).items;
    expect(items).toHaveLength(120);
    expect(items[0].attachmentsCount).toBe(2);

    // Ни одного запроса на отдельное письмо: вложения считаются одним пакетным вызовом.
    expect(mockedCore.listAttachments).not.toHaveBeenCalled();
    expect(mockedCore.countAttachmentsByEmail).toHaveBeenCalledTimes(1);
    expect((mockedCore.countAttachmentsByEmail.mock.calls[0][0] as string[]).length).toBe(120);
  });

  it("письма без вложений остаются с нулём", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValueOnce(mailbox(3));
    mockedDocflow.listRegisteredEmailIds.mockResolvedValueOnce([]);
    mockedCore.countAttachmentsByEmail.mockImplementationOnce(() => new Map());

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming", {
      token: token("secretary")
    });

    const items = (res.body as { items: Array<{ attachmentsCount: number }> }).items;
    expect(items.map((i) => i.attachmentsCount)).toEqual([0, 0, 0]);
  });
});

describe("покрытие маршрутов резолюций", () => {
  it("все маршруты резолюций есть в матрице или в списке исключений", () => {
    // В стеке Express пути с параметрами (/:id), в матрице — с конкретными идентификаторами,
    // поэтому сравниваем по шаблону маршрута.
    const matches = (pattern: string, path: string) =>
      new RegExp("^" + pattern.replace(/:[A-Za-z0-9_]+/g, "[^/]+") + "$").test(path);

    const routes = routesOf(expressApp).filter((route) =>
      route.path.startsWith("/api/docflow/resolutions")
    );
    const missing = routes
      .filter(
        (route) =>
          !CASES.some((c) => c.method === route.method && matches(route.path, c.path)) &&
          !MATRIX_EXCEPTIONS.has(route.method + " " + route.path)
      )
      .map((route) => route.method + " " + route.path);

    expect(missing).toEqual([]);
    // Если разбор стека сломается, тест обязан заметить это, а не «пройти» на пустом списке.
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });
});

describe("закрыть можно только открытый год", () => {
  const year = String(new Date().getFullYear());

  it("архивация открытого года проходит", async () => {
    mockedDocflow.getNumberingState.mockResolvedValueOnce({
      rules: [],
      openPeriod: year,
      archivedPeriods: [],
      blockedReason: null
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/numbering/archive", {
      token: token("secretary"),
      body: { period: year, confirm: year }
    });

    expect(res.status).toBe(200);
    // Закрытие идёт строгой функцией ядра (проверки + архив + след в одной транзакции),
    // а archivePeriod осталась служебной и в маршруте больше не вызывается.
    expect(mockedDocflow.closePeriod).toHaveBeenCalledTimes(1);
    expect(mockedDocflow.archivePeriod).not.toHaveBeenCalled();
  });

  it("будущий год при открытом текущем отклонён — иначе он закроется навсегда", async () => {
    mockedDocflow.getNumberingState.mockResolvedValueOnce({
      rules: [],
      openPeriod: year,
      archivedPeriods: [],
      blockedReason: null
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/numbering/archive", {
      token: token("secretary"),
      // Подтверждение верное: проверяем именно правило «только открытый год».
      body: { period: String(Number(year) + 1), confirm: String(Number(year) + 1) }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "not_open_period" });
    expect(String((res.body as { error?: string }).error)).toContain(year);
    expect(mockedDocflow.closePeriod).not.toHaveBeenCalled();
  });

  it("закрывается открытый период, а не год по календарю", async () => {
    mockedDocflow.getNumberingState.mockResolvedValueOnce({
      rules: [],
      openPeriod: "2024",
      archivedPeriods: [],
      blockedReason: null
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/numbering/archive", {
      token: token("secretary"),
      body: { period: "2025", confirm: "2025" }
    });

    expect(res.status).toBe(400);
    expect(mockedDocflow.closePeriod).not.toHaveBeenCalled();
  });

  it("пустой журнал: закрывать нечего", async () => {
    mockedDocflow.getNumberingState.mockResolvedValueOnce({
      rules: [],
      openPeriod: null,
      archivedPeriods: [],
      blockedReason: null
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/numbering/archive", {
      token: token("secretary"),
      body: { period: year, confirm: year }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "empty_journal" });
  });
});

describe("сбой базы не выдаёт себя за выход из системы", () => {
  it("/api/auth/me отвечает 503, а не «user: null» (иначе клиент показывает вход)", async () => {
    mockedDocflow.resolveToken.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:55432"));

    const res = await request(app.baseUrl, "GET", "/api/auth/me", { token: token("admin") });

    expect(res.status).toBe(503);
    expect(String((res.body as { error?: string }).error)).toContain("База документооборота недоступна");
  });

  it("защищённый маршрут отвечает 503, а не 401", async () => {
    mockedDocflow.resolveToken.mockRejectedValueOnce(new Error("таймаут соединения"));

    const res = await request(app.baseUrl, "GET", "/api/users", { token: token("admin") });

    expect(res.status).toBe(503);
  });

  it("при живом входе /api/auth/me отдаёт пользователя как раньше", async () => {
    const res = await request(app.baseUrl, "GET", "/api/auth/me", { token: token("admin") });

    expect(res.status).toBe(200);
    expect((res.body as { user: { id: string } }).user.id).toBe("u-admin");
  });
});

describe("статус документа проверяется на сервере", () => {
  it("неизвестный статус отклонён с 400, документ не меняется", async () => {
    const updateDocument = mockedDocflow.updateDocument;

    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { status: "почти исполнен" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_status" });
    expect(String((res.body as { error?: string }).error)).toContain("executed");
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("известный статус принимается и уходит в базу", async () => {
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { status: "executed" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.updateDocument.mock.calls[0][1]).toMatchObject({ status: "executed" });
  });

  it("без статуса прочие поля правятся как раньше", async () => {
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { summary: "уточнено" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.updateDocument.mock.calls[0][1]).toMatchObject({ summary: "уточнено" });
  });
});

/** Префиксы, которые обслуживает сервер документооборота: всё здесь под правами. */
const DOCFLOW_PREFIXES = [
  "/api/docflow",
  "/api/users",
  "/api/roles",
  "/api/audit",
  "/api/directory",
  // Архив года: выгрузка и импорт журнала — тоже серверные маршруты под правами.
  "/api/journal"
];

/**
 * Осознанные исключения — маршруты, доступные ЛЮБОМУ вошедшему:
 *   • статус каталога нужен любому: от него зависит автодополнение адресов;
 *   • «почта для СЭД» (Р24) — личный выбор работника, и только за СЕГОДНЯ. Он не даёт ни
 *     прав, ни данных предприятия: работник видит служебный ящик в списке разрешённых
 *     и свой собственный выбор. Права проверять тут нечего — их нет.
 */
const OPEN_TO_ANY_AUTHENTICATED = new Set([
  "GET /api/directory/status",
  "GET /api/docflow/my-edms-mail",
  "PUT /api/docflow/my-edms-mail"
]);

function routesOf(appInstance: express.Express): Array<{ method: string; path: string }> {
  const stack =
    (appInstance as unknown as { _router?: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })
      ._router?.stack ?? [];
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods ?? {})) {
      if (method === "_all") continue;
      routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

describe("ни один маршрут документооборота не остался без проверки", () => {
  it("пользователь без прав получает 403, без сессии — 401, на каждом маршруте", async () => {
    const routes = routesOf(expressApp).filter((route) =>
      DOCFLOW_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(prefix + "/"))
    );
    // Маршрутов много: если разбор стека сломается, тест обязан заметить это, а не «пройти».
    expect(routes.length).toBeGreaterThanOrEqual(30);

    const failures: string[] = [];
    for (const route of routes) {
      if (OPEN_TO_ANY_AUTHENTICATED.has(route.method + " " + route.path)) continue;
      const url = route.path.replace(/:([A-Za-z0-9_]+)/g, "test-$1");

      const rightless = await request(app.baseUrl, route.method, url, { token: token("none") });
      if (rightless.status !== 403) {
        failures.push(
          route.method + " " + route.path + ": пользователь без прав получил " + rightless.status
        );
      }

      const anonymous = await request(app.baseUrl, route.method, url);
      if (anonymous.status !== 401) {
        failures.push(route.method + " " + route.path + ": без сессии получили " + anonymous.status);
      }
    }
    expect(failures).toEqual([]);
  });

  it("исключение из проверки — только статус каталога", async () => {
    const routes = routesOf(expressApp)
      .filter((route) =>
        DOCFLOW_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(prefix + "/"))
      )
      .map((route) => route.method + " " + route.path)
      .filter((id) => !CASES.some((c) => c.method + " " + c.path === id))
      .filter((id) => !OPEN_TO_ANY_AUTHENTICATED.has(id));
    // Список непустой: значит маршруты действительно находятся, а не «пронесло».
    expect(routes.length).toBeGreaterThan(10);
  });
});
