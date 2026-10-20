/**
 * Состязательная проверка закрытия D-4: права на почту (task-42, продолжение task-39).
 *
 * Проверяем не «есть ли guard в коде», а поведение: под каждой ролью идём на КАЖДЫЙ почтовый
 * маршрут, включая обходные попытки (подстановка чужих id в query/теле/пути, массовые операции,
 * PATCH, внутренние маршруты). Ожидание всюду одно: чужая роль получает отказ ДО обработчика,
 * то есть 403, а не «случайно 200».
 *
 * ⚠️ Пакет server подменяет @mailsense/docflow и @mailsense/core. Права ролей берутся НАСТОЯЩИЕ
 * (docflow/roles.ts через testing/mocks.ts), поэтому матрица проверяет продуктовую модель прав,
 * а не её копию в тесте. Параметры запроса подставляются заведомо «чужие»: если бы guard стоял
 * после выбора данных или зависел от параметров, тест это поймает.
 *
 * Личные маршруты (черновики, шаблоны, профиль) по решению T39 остаются доступны любому
 * вошедшему — это собственные данные работника; они проверяются отдельным блоком как 200.
 */
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => {
  const m = require("./testing/mocks.js").docflowMockModule() as Record<string, unknown>;
  // След отказа доступа к письму-источнику: проверяем и его, не только код ответа.
  m.writeAudit = jest.fn(async () => null);
  return m;
});

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, TestUser>;
};
const mockedCore = core as unknown as Record<string, jest.Mock>;

const ROLES = ["admin", "secretary", "manager", "signer", "executor"] as const;
/** Роли с правом на почту (см. docflow/roles.ts): читает и отправляет аппарат и администратор. */
const MAIL_ROLES = ["admin", "secretary"];
const token = (role: string) => "mail:" + role;

/** Чужие идентификаторы: используются во всех обходных попытках. */
const FOREIGN_EMAIL = "email-чужой";
const FOREIGN_ATT = "att-чужое";
const FOREIGN_ACC = "acc-чужой";

let app: RunningApp;

beforeAll(async () => {
  for (const role of [...ROLES, "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

const call = (method: string, path: string, role?: string, body?: unknown) =>
  request(app.baseUrl, method, path, { token: role ? token(role) : undefined, body });

interface Case { what: string; method: string; path: string; body?: unknown; allow: string[] }

/** Своя почта: граница — владелец ящика, права роли не нужны. */
const READ_CASES: Case[] = [
  { what: "GET /api/emails — список писем", method: "GET", path: "/api/emails", allow: MAIL_ROLES },
  { what: "GET /api/emails?accountId=ЧУЖОЙ — чужой ящик в параметре не помогает", method: "GET", path: "/api/emails?accountId=" + FOREIGN_ACC, allow: MAIL_ROLES },
  { what: "GET /api/emails/:id — карточка письма", method: "GET", path: "/api/emails/" + FOREIGN_EMAIL, allow: MAIL_ROLES },
  { what: "PATCH /api/emails/:id/folder — перекладывание письма", method: "PATCH", path: "/api/emails/" + FOREIGN_EMAIL + "/folder", body: { folder: "INBOX" }, allow: MAIL_ROLES },
  { what: "PATCH /api/emails/:id/external-number — правка реквизитов", method: "PATCH", path: "/api/emails/" + FOREIGN_EMAIL + "/external-number", body: { externalNumber: "X" }, allow: MAIL_ROLES },
  { what: "PATCH /api/emails/:id/send-date — правка даты отправки", method: "PATCH", path: "/api/emails/" + FOREIGN_EMAIL + "/send-date", body: { sendDate: "2026-01-01" }, allow: MAIL_ROLES },
  { what: "GET /api/emails/:id/ics — выгрузка в календарь", method: "GET", path: "/api/emails/" + FOREIGN_EMAIL + "/ics", allow: MAIL_ROLES },
  { what: "GET /api/emails/:id/attachments/:attId/file — скачивание вложения", method: "GET", path: "/api/emails/" + FOREIGN_EMAIL + "/attachments/" + FOREIGN_ATT + "/file", allow: MAIL_ROLES },
  { what: "GET /api/emails/:id/attachments/:attId/preview — рендер вложения", method: "GET", path: "/api/emails/" + FOREIGN_EMAIL + "/attachments/" + FOREIGN_ATT + "/preview", allow: MAIL_ROLES },
  { what: "GET /api/threads — переписки", method: "GET", path: "/api/threads", allow: MAIL_ROLES },
  { what: "POST /api/threads/rebuild — пересборка переписок", method: "POST", path: "/api/threads/rebuild", body: {}, allow: MAIL_ROLES },
  { what: "PATCH /api/analysis/:emailId — правка сводки/категории", method: "PATCH", path: "/api/analysis/" + FOREIGN_EMAIL, body: { category: "spam" }, allow: MAIL_ROLES },
  { what: "POST /api/emails/:id/analyze — запуск анализа", method: "POST", path: "/api/emails/" + FOREIGN_EMAIL + "/analyze", body: {}, allow: MAIL_ROLES },
  { what: "POST /api/emails/bulk/analyze — пакетный анализ по id", method: "POST", path: "/api/emails/bulk/analyze", body: { ids: [FOREIGN_EMAIL] }, allow: MAIL_ROLES },
  { what: "POST /api/emails/bulk/folder — массовое перекладывание", method: "POST", path: "/api/emails/bulk/folder", body: { ids: [FOREIGN_EMAIL], folder: "TRASH" }, allow: MAIL_ROLES },
  { what: "POST /api/emails/bulk/delete — массовое УДАЛЕНИЕ писем", method: "POST", path: "/api/emails/bulk/delete", body: { ids: [FOREIGN_EMAIL] }, allow: MAIL_ROLES },
  { what: "GET /api/compose-template — шаблон ответа по чужому письму", method: "GET", path: "/api/compose-template?accountId=" + FOREIGN_ACC + "&emailId=" + FOREIGN_EMAIL, allow: MAIL_ROLES },
  // ⚠️ Ящики в этот список НЕ входят: с 13.10.2026 граница проходит по владельцу, а не по праву
  // (docs/design/mail-ownership.md). Чужой ящик не виден никому, свой доступен без роли —
  // проверки в отдельном describe ниже.
];

/** Отправка и импорт — тоже по владельцу ящика. */
const SEND_CASES: Case[] = [
  { what: "POST /api/emails/send — отправка письма", method: "POST", path: "/api/emails/send", body: {}, allow: MAIL_ROLES },
  { what: "POST /api/import — импорт писем в ящик", method: "POST", path: "/api/import", body: { accountId: FOREIGN_ACC, files: [] }, allow: MAIL_ROLES }
];

/** Управление ящиками и настройками предприятия — settings.manage. */
const MANAGE_CASES: Case[] = [
  // ⚠️ GET /api/settings сюда НЕ входит: «Общие» открыты вошедшему с безопасным минимумом
  // (auto_fetch/auto_analyze/pollIntervalSeconds), но без секретов и настроек каталога.
  { what: "PUT /api/settings — смена настроек предприятия", method: "PUT", path: "/api/settings", body: { "ai.model": "x" }, allow: ["admin"] },
  { what: "GET /api/ai/config — ключ модели", method: "GET", path: "/api/ai/config", allow: ["admin"] },
  { what: "PUT /api/ai/config — смена ключа модели", method: "PUT", path: "/api/ai/config", body: {}, allow: ["admin"] },
  { what: "POST /api/ai/test — проверка модели", method: "POST", path: "/api/ai/test", body: {}, allow: ["admin"] }
];

describe("D-4 · почта работника: доступна любому вошедшему, граница — владелец", () => {
  for (const c of READ_CASES) {
    it(c.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const res = await call(c.method, c.path, role, c.body);
        // Права роли на СВОЮ почту больше не нужны: 403 означал бы, что человек без ролей
        // не может пользоваться своим же ящиком. Чужие данные — 404, это в блоке ниже.
        if (res.status === 401 || res.status === 403) {
          failures.push(role + ": отбит по правам — " + res.status + " " + res.text.slice(0, 100));
        }
      }
      const anon = await call(c.method, c.path, undefined, c.body);
      if (anon.status !== 401) failures.push("без сессии: ждали 401, получили " + anon.status);
      expect(failures).toEqual([]);
    });
  }

  it("обходной путь «чужой id в параметре»: 404 и к ядру не обращаемся", async () => {
    for (const role of ROLES) {
      const res = await call("GET", "/api/emails?accountId=" + FOREIGN_ACC, role);
      expect(res.status).toBe(404);
    }
    expect(mockedCore.listEmailsWithAnalysis).not.toHaveBeenCalled();
  });
});

describe("D-4 · чужие данные не отдаются: 404 вместо чужого содержимого", () => {
  it("карточка, календарь, вложения, правки, анализ и шаблон по чужому письму", async () => {
    for (const role of ROLES) {
      expect((await call("GET", "/api/emails/" + FOREIGN_EMAIL, role)).status).toBe(404);
      expect((await call("GET", "/api/emails/" + FOREIGN_EMAIL + "/ics", role)).status).toBe(404);
      expect((await call("GET", "/api/emails/" + FOREIGN_EMAIL + "/attachments/" + FOREIGN_ATT + "/file", role)).status).toBe(404);
      expect((await call("GET", "/api/emails/" + FOREIGN_EMAIL + "/attachments/" + FOREIGN_ATT + "/preview", role)).status).toBe(404);
      expect((await call("PATCH", "/api/emails/" + FOREIGN_EMAIL + "/folder", role, { folder: "TRASH" })).status).toBe(404);
      expect((await call("PATCH", "/api/emails/" + FOREIGN_EMAIL + "/external-number", role, { externalNumber: "X" })).status).toBe(404);
      expect((await call("PATCH", "/api/emails/" + FOREIGN_EMAIL + "/send-date", role, { sendDate: "2026-01-01" })).status).toBe(404);
      expect((await call("PATCH", "/api/analysis/" + FOREIGN_EMAIL, role, { category: "spam" })).status).toBe(404);
      expect((await call("POST", "/api/emails/" + FOREIGN_EMAIL + "/analyze", role, {})).status).toBe(404);
      expect((await call("GET", "/api/compose-template?accountId=" + FOREIGN_ACC + "&mode=new", role)).status).toBe(404);
      expect((await call("POST", "/api/emails/send", role, { accountId: FOREIGN_ACC })).status).toBe(404);
      expect((await call("POST", "/api/import", role, { accountId: FOREIGN_ACC, files: [{ filename: "a.txt", data: "AA==" }] })).status).toBe(404);
      expect((await call("POST", "/api/threads/rebuild", role, { accountId: FOREIGN_ACC })).status).toBe(404);
    }
  });

  it("массовые операции с чужими id не трогают чужое: ядру уходит пустой список", async () => {
    const res = await call("POST", "/api/emails/bulk/delete", "executor", { ids: [FOREIGN_EMAIL] });
    expect(res.status).toBe(200);
    expect(mockedCore.deleteEmails).toHaveBeenLastCalledWith([]);
  });
});

describe("D-4 · пакетный анализ идёт по СВОИМ ящикам — права роли не нужны", () => {
  // ⚠️ Раньше здесь требовалось mail.view («почта предприятия»). Права больше нет: разбор
  // идёт по ящикам самого работника (сервер фильтрует по владельцу), а чужое ему недоступно.
  const ANALYZE: Case[] = [
    { what: "GET /api/analysis/progress — состояние анализа", method: "GET", path: "/api/analysis/progress" },
    { what: "POST /api/emails/analyze-all — пакетный анализ", method: "POST", path: "/api/emails/analyze-all", body: {} },
    { what: "POST /api/emails/analyze-range — анализ диапазона", method: "POST", path: "/api/emails/analyze-range", body: {} },
    { what: "POST /api/emails/analyze-stop — остановка анализа", method: "POST", path: "/api/emails/analyze-stop", body: {} }
  ];
  for (const c of ANALYZE) {
    it(c.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const res = await call(c.method, c.path, role, c.body);
        if (res.status === 401 || res.status === 403) failures.push(role + ": отбит по правам — " + res.status);
      }
      const anon = await call(c.method, c.path, undefined, c.body);
      if (anon.status !== 401) failures.push("без сессии: ждали 401, получили " + anon.status);
      expect(failures).toEqual([]);
    });
  }
});

describe("D-4 · аппарат и администратор реально читают почту (200, а не «пропустили и упало»)", () => {
  it("GET /api/emails, /api/threads, /api/analysis/progress под admin и secretary — 200", async () => {
    for (const role of MAIL_ROLES) {
      const list = await call("GET", "/api/emails", role);
      expect(list.status).toBe(200);
      const threads = await call("GET", "/api/threads", role);
      expect(threads.status).toBe(200);
      const progress = await call("GET", "/api/analysis/progress", role);
      expect(progress.status).toBe(200);
    }
  });
});

describe("D-4 · отправка и импорт: нужен свой ящик, права роли не нужны", () => {
  for (const c of SEND_CASES) {
    it(c.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const res = await call(c.method, c.path, role, c.body);
        // Пустой или чужой ящик — 404; отказа по правам быть не должно.
        if (res.status === 401 || res.status === 403) failures.push(role + ": отбит по правам — " + res.status);
      }
      const anon = await call(c.method, c.path, undefined, c.body);
      if (anon.status !== 401) failures.push("без сессии: ждали 401, получили " + anon.status);
      expect(failures).toEqual([]);
    });
  }

  it("отправка с чужим ящиком не доходит до почтового ядра", async () => {
    await call("POST", "/api/emails/send", "executor", { accountId: FOREIGN_ACC, to: ["a@b.c"], subject: "x", bodyText: "y" });
    await call("POST", "/api/emails/send", "manager", { accountId: FOREIGN_ACC });
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
  });
});

describe("D-4 · управление ящиками и настройками: settings.manage", () => {
  for (const c of MANAGE_CASES) {
    it(c.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const res = await call(c.method, c.path, role, c.body);
        if (c.allow.includes(role)) {
          if (res.status === 401 || res.status === 403) {
            failures.push(role + ": guard НЕ пропустил — " + res.status + " " + res.text.slice(0, 100));
          }
        } else if (res.status !== 403) {
          failures.push(role + ": ждали 403, получили " + res.status + " — " + res.text.slice(0, 100));
        }
      }
      const anon = await call(c.method, c.path, undefined, c.body);
      if (anon.status !== 401) failures.push("без сессии: ждали 401, получили " + anon.status);
      expect(failures).toEqual([]);
    });
  }
});

describe("D-4 · ящики: граница по владельцу, а не по праву", () => {
  it("чужой ящик не виден в списке ни одной роли", async () => {
    for (const role of ROLES) {
      const res = await call("GET", "/api/accounts", role);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).not.toContain(FOREIGN_ACC);
    }
  });

  it("свой ящик заводит любой вошедший: роли guard не отбивает", async () => {
    for (const role of ROLES) {
      const res = await call("POST", "/api/accounts", role, {});
      expect([401, 403]).not.toContain(res.status);
    }
    expect((await call("POST", "/api/accounts", undefined, {})).status).toBe(401);
  });

  it("правка, удаление и скан ЧУЖОГО ящика — 404 у всех, включая администратора", async () => {
    for (const role of ROLES) {
      expect((await call("PUT", "/api/accounts/" + FOREIGN_ACC, role, {})).status).toBe(404);
      expect((await call("DELETE", "/api/accounts/" + FOREIGN_ACC, role)).status).toBe(404);
      expect((await call("POST", "/api/accounts/" + FOREIGN_ACC + "/fetch", role, {})).status).toBe(404);
    }
  });

  it("проверка соединения доступна любому вошедшему", async () => {
    for (const role of ROLES) {
      const res = await call("POST", "/api/accounts/test", role, {});
      expect([401, 403]).not.toContain(res.status);
    }
  });
});

describe("D-4 · личные маршруты остаются доступны любому вошедшему", () => {
  const PERSONAL: Array<{ what: string; method: string; path: string; body?: unknown }> = [
    { what: "GET /api/drafts — свои черновики", method: "GET", path: "/api/drafts" },
    { what: "POST /api/drafts — свой черновик", method: "POST", path: "/api/drafts", body: { accountId: "acc-1", to: [], subject: "s", bodyText: "b", attachments: [] } },
    { what: "GET /api/templates — свои шаблоны", method: "GET", path: "/api/templates" },
    { what: "POST /api/templates — свой шаблон", method: "POST", path: "/api/templates", body: { name: "Шаблон", accountId: "acc-1" } },
    { what: "GET /api/mail-profile — свой профиль", method: "GET", path: "/api/mail-profile" },
    { what: "PUT /api/mail-profile — своя подпись", method: "PUT", path: "/api/mail-profile", body: { signatureText: "с уважением" } }
  ];
  for (const c of PERSONAL) {
    it(c.what + " (исполнителю — 200, без сессии — 401)", async () => {
      const asExecutor = await call(c.method, c.path, "executor", c.body);
      expect([200, 201]).toContain(asExecutor.status);
      const anon = await call(c.method, c.path, undefined, c.body);
      expect(anon.status).toBe(401);
    });
  }
});

describe("T41 · письмо-источник: только участнику своего поручения", () => {
  const RES = "res-1";
  const detail = (patch: Record<string, unknown> = {}) => ({
    id: RES,
    documentId: "doc-1",
    documentNumber: "вх1",
    text: "Подготовить ответ",
    deadline: null,
    status: "sent",
    preparedBy: "u-secretary",
    approvedBy: "u-signer",
    confirmedBy: null,
    dispatchedBy: "u-secretary",
    assignees: [{ userId: "u-executor", fullName: "Петрова М.А.", email: "petrova@stand.test", kind: "responsible" }],
    documentEmailId: "email-1",
    ...patch
  });

  beforeEach(() => {
    mockedDocflow.getResolutionDetail.mockResolvedValue(detail());
    mockedCore.getEmailView.mockReturnValue({
      id: "email-1",
      subject: "Тема письма",
      from: { address: "sender@stand.test", name: "Отправитель" },
      to: [],
      cc: [],
      date: "2026-10-07T00:00:00.000Z",
      bodyText: "Тело письма",
      bodyHtml: null
    });
    mockedCore.listAttachments.mockReturnValue([]);
  });

  const src = (role: string | undefined, res = RES) =>
    request(app.baseUrl, "GET", "/api/docflow/tasks/" + res + "/source-email", { token: role ? token(role) : undefined });
  const att = (role: string | undefined, attachmentId: string, res = RES) =>
    request(app.baseUrl, "GET", "/api/docflow/tasks/" + res + "/source-email/attachments/" + attachmentId, {
      token: role ? token(role) : undefined
    });

  it("без сессии → 401; без права task.view → 403, данные не читаются", async () => {
    expect((await src(undefined)).status).toBe(401);
    expect((await src("none")).status).toBe(403);
    expect(mockedDocflow.getResolutionDetail).not.toHaveBeenCalled();
  });

  it("исполнитель своего поручения → 200, и в ответе НЕТ служебных полей ящика", async () => {
    const res = await src("executor");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "attachments",
        "bodyHtml",
        "bodyText",
        "cc",
        "date",
        "emailId",
        "from",
        // Своя копия письма о поручении: это id, а не служебное поле ящика
        // (accountId/uid/folder/path запрещены и проверяются ниже).
        "ownEmailId",
        "resolutionId",
        "subject",
        "to"
      ].sort()
    );
    for (const key of Object.keys(body)) {
      expect(/account|uid|folder|storage|path/i.test(key)).toBe(false);
    }
    expect(body.emailId).toBe("email-1");
    expect(body.subject).toBe("Тема письма");
  });

  it("подписант (утвердивший поручение) → 200", async () => {
    expect((await src("signer")).status).toBe(200);
  });

  it("чужая задача → 403, письмо не читается, отказ оставляет след", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValue(
      detail({
        assignees: [{ userId: "u-другой", fullName: "Другой", email: "x@stand.test", kind: "responsible" }],
        preparedBy: "u-другой",
        approvedBy: null,
        dispatchedBy: null
      })
    );
    const res = await src("executor");
    expect(res.status).toBe(403);
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
    expect(mockedDocflow.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resolution.source_email_denied", entityType: "resolution", entityId: RES })
    );
  });

  it("письмо не связано с поручением → 404 (даже своему)", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValue(detail({ documentEmailId: null }));
    expect((await src("executor")).status).toBe(404);
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
  });

  it("несуществующее поручение → 404", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValue(null);
    expect((await src("executor", "нет-такого")).status).toBe(404);
  });

  it("своё вложение отдаётся, подставленное ЧУЖОЕ — нет", async () => {
    mockedCore.listAttachments.mockReturnValue([
      { id: "att-1", filename: "свой.pdf", mimeType: "application/pdf", size: 10, storagePath: __filename }
    ]);
    const own = await att("executor", "att-1");
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toContain("application/pdf");

    // Вложение существует, но принадлежит ДРУГОМУ письму: подстановка id ничего не даёт.
    expect((await att("executor", FOREIGN_ATT)).status).toBe(404);
  });

  it("чужая задача + её вложение → 403 (проверка связи и здесь)", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValue(
      detail({
        assignees: [{ userId: "u-другой", fullName: "Другой", email: "x@stand.test", kind: "responsible" }],
        preparedBy: "u-другой",
        approvedBy: null,
        dispatchedBy: null
      })
    );
    mockedCore.listAttachments.mockReturnValue([
      { id: "att-чужой", filename: "чужой.pdf", mimeType: "application/pdf", size: 10, storagePath: __filename }
    ]);
    expect((await att("executor", "att-чужой")).status).toBe(403);
  });

  it("перечисления нет: список писем-источников не существует как маршрут", async () => {
    const list = await request(app.baseUrl, "GET", "/api/docflow/tasks/source-email", { token: token("executor") });
    expect(list.status).toBe(404);
    const all = await request(app.baseUrl, "GET", "/api/docflow/tasks/source-email/list", { token: token("executor") });
    expect(all.status).toBe(404);
  });
});
