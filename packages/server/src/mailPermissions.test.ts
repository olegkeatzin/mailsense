import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Права на почту предприятия (D-4, план Т5).
 *
 * В варианте А на сервере лежат СЛУЖЕБНЫЕ ящики аппарата: без этих проверок любой вошедший —
 * исполнитель или внешний партнёр — читал бы переписку аппарата и отправлял письма от его имени.
 *
 * Матрица:
 *   • своя почта (письма, вложения, треды, анализ, список ящиков, шаблон, отправка) → по ВЛАДЕЛЬЦУ
 *     ящика, без права роли: прав mail.view/mail.send в каталоге больше нет;
 *   • управление ящиками и системные настройки → settings.manage;
 *   • личные маршруты (черновики, шаблоны, профиль) → любому вошедшему.
 *
 * ⚠️ Отдельно проверяем, что закрытие дыры НЕ ломает работу исполнителя: своё поручение
 * он по-прежнему видит (task.view), хотя почта ему недоступна.
 */
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const TOKENS = {
  admin: "token:admin",
  secretary: "token:secretary",
  executor: "token:executor",
  partner: "token:partner",
  none: "token:none"
};

/** Методы и пути, которые обязаны требовать соответствующее право. */
const READ_ROUTES: Array<[string, string]> = [
  ["GET", "/api/emails"],
  ["GET", "/api/emails/e-1"],
  ["GET", "/api/emails/e-1/ics"],
  ["GET", "/api/emails/e-1/attachments/a-1/file"],
  ["GET", "/api/emails/e-1/attachments/a-1/preview"],
  ["GET", "/api/threads"],
  ["GET", "/api/analysis/progress"],
  ["GET", "/api/compose-template?accountId=acc-1&mode=new"],
  ["PATCH", "/api/emails/e-1/folder"],
  ["PATCH", "/api/emails/e-1/external-number"],
  ["PATCH", "/api/emails/e-1/send-date"],
  ["PATCH", "/api/analysis/e-1"],
  ["POST", "/api/emails/e-1/analyze"],
  ["POST", "/api/emails/analyze-all"],
  ["POST", "/api/emails/analyze-range"],
  ["POST", "/api/emails/analyze-stop"],
  ["POST", "/api/emails/bulk/analyze"],
  ["POST", "/api/emails/bulk/folder"],
  ["POST", "/api/emails/bulk/delete"],
  ["POST", "/api/threads/rebuild"],
];

const SEND_ROUTES: Array<[string, string]> = [
  ["POST", "/api/emails/send"],
  ["POST", "/api/import"]
];

const MANAGE_ROUTES: Array<[string, string]> = [
  ["GET", "/api/settings"],
  ["PUT", "/api/settings"],
  ["GET", "/api/ai/config"],
  ["PUT", "/api/ai/config"],
  ["GET", "/api/ai/prompt"],
  ["PUT", "/api/ai/prompt"],
  ["POST", "/api/ai/test"],
  ["POST", "/api/accounts/acc-1/test-smtp"]
];

const ALL_ROUTES = [...READ_ROUTES, ...SEND_ROUTES, ...MANAGE_ROUTES];

let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(TOKENS.admin, testUser("u-admin", ["admin"]));
  mockedDocflow.__sessions.set(TOKENS.secretary, testUser("u-secretary", ["secretary"]));
  mockedDocflow.__sessions.set(TOKENS.executor, testUser("u-executor", ["executor"]));
  mockedDocflow.__sessions.set(TOKENS.partner, testUser("u-partner", []));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

const call = (method: string, path: string, token?: string) =>
  request(app.baseUrl, method, path, {
    ...(token ? { token } : {}),
    ...(method === "GET" || method === "DELETE" ? {} : { body: {} })
  });

/** Управление настройками и ИИ — права предприятия, а не личные данные. */
describe("права предприятия закрыты для чужих (D-4)", () => {
  it.each(MANAGE_ROUTES)("исполнитель без прав: %s %s → 403", async (method, path) => {
    const res = await call(method, path, TOKENS.executor);
    expect(res.status).toBe(403);
  });

  it.each(MANAGE_ROUTES)("внешний партнёр (без ролей): %s %s → 403", async (method, path) => {
    const res = await call(method, path, TOKENS.partner);
    expect(res.status).toBe(403);
  });

  it.each(ALL_ROUTES)("без сессии: %s %s → 401", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });
});

/**
 * Личная почта — не право роли, а собственные данные: граница проходит по владельцу
 * (docs/design/mail-ownership.md). Отказ по правам здесь был бы регрессией: человек
 * без ролей обязан пользоваться своим ящиком. Пакетный анализ почты остаётся правом.
 */
describe("личная почта доступна любому вошедшему: прав на почту у ролей нет", () => {
  // ⚠️ Раньше здесь был отдельный список «пакетный анализ — по праву mail.view». Права больше
  // нет: разбор идёт по ящикам самого работника (сервер фильтрует по владельцу), чужое ему
  // недоступно, поэтому и пакетные операции открыты вошедшему.
  const MAIL_ROUTES = [...READ_ROUTES, ...SEND_ROUTES];

  it.each(MAIL_ROUTES)("без ролей не отбивается по правам: %s %s", async (method, path) => {
    for (const t of [TOKENS.executor, TOKENS.partner]) {
      const res = await call(method, path, t);
      expect([401, 403]).not.toContain(res.status);
    }
  });
});

describe("ящики: граница по владельцу, а не по праву (docs/design/mail-ownership.md)", () => {
  it("чужой ящик не виден в списке: исполнителю и партнёру — пусто", async () => {
    for (const t of [TOKENS.executor, TOKENS.partner]) {
      const res = await call("GET", "/api/accounts", t);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });

  it("владелец видит свой ящик", async () => {
    const res = await call("GET", "/api/accounts", TOKENS.admin);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((a) => a.id)).toEqual(["acc-1"]);
  });

  it("чужой ящик не правится, не удаляется и не сканируется — 404", async () => {
    for (const t of [TOKENS.secretary, TOKENS.executor, TOKENS.partner]) {
      expect((await call("PUT", "/api/accounts/acc-1", t)).status).toBe(404);
      expect((await call("DELETE", "/api/accounts/acc-1", t)).status).toBe(404);
      expect((await call("POST", "/api/accounts/acc-1/fetch", t)).status).toBe(404);
    }
    // Ящик стенда принадлежит u-admin: для него это свой ящик, и отказа по правам быть не должно.
    expect((await call("PUT", "/api/accounts/acc-1", TOKENS.admin)).status).not.toBe(403);
  });

  it("свой ящик заводит любой вошедший, без сессии — 401", async () => {
    for (const t of [TOKENS.executor, TOKENS.partner]) {
      const res = await call("POST", "/api/accounts", t);
      expect([401, 403]).not.toContain(res.status);
    }
    expect((await call("POST", "/api/accounts")).status).toBe(401);
  });
});

describe("аппарат работает с почтой, но не управляет предприятием", () => {
  it.each([...READ_ROUTES, ...SEND_ROUTES])("аппарат проходит проверку прав: %s %s", async (method, path) => {
    const res = await call(method, path, TOKENS.secretary);
    // Право есть — значит отказа по правам быть не должно (дальше может быть 400/404/500
    // из-за моков, это не про права).
    expect([401, 403]).not.toContain(res.status);
  });

  it.each(MANAGE_ROUTES)("аппарату закрыто управление: %s %s → 403", async (method, path) => {
    const res = await call(method, path, TOKENS.secretary);
    expect(res.status).toBe(403);
  });
});

describe("администратор проходит везде", () => {
  it.each(ALL_ROUTES)("админ: %s %s — нет отказа по правам", async (method, path) => {
    const res = await call(method, path, TOKENS.admin);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("личные данные и работа исполнителя не сломаны", () => {
  it.each([
    ["GET", "/api/drafts"],
    ["GET", "/api/templates"],
    ["GET", "/api/mail-profile"]
  ])("исполнителю доступно личное: %s %s", async (method, path) => {
    const res = await call(method, path, TOKENS.executor);
    expect(res.status).toBe(200);
  });

  it("исполнитель по-прежнему видит своё поручение через документооборот", async () => {
    const res = await call("GET", "/api/docflow/resolutions/my-tasks", TOKENS.executor);
    // Право task.view у исполнителя есть, почта для этого не нужна.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});
