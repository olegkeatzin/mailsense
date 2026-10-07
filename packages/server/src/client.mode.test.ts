import http from "node:http";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, sleep, type RunningApp } from "./testing/harness.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Режим клиента (вариант А, task-22).
 *
 * ⚠️ Граница изменилась: почта теперь живёт НА СЕРВЕРЕ (там служебные ящики аппарата),
 * поэтому почтовые пути проксируются целиком — `/api/emails`, `/api/accounts`,
 * `/api/threads`, `/api/analysis`, `/api/import`, `/api/compose-template`,
 * `/api/settings`, `/api/ai`. Локальными остаются ЛИЧНЫЕ вещи работника: черновики,
 * шаблоны и будущий `/api/mail-profile`.
 *
 * Раньше здесь проверялось обратное («почта локальная и работает без СЭД») — это описание
 * прежней топологии, а не текущего продукта. Что осталось непреложным: личные данные
 * работника на сервер не уезжают, а недоступный сервер даёт ЧЕСТНУЮ ошибку, а не пустой список.
 */

const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

/** Удалённый СЭД: сессию принимает только токен token:valid; остальное отдаёт как «серверное». */
const remotePaths: string[] = [];
async function remoteDocflow(): Promise<RunningApp> {
  return listen((req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    remotePaths.push(path);
    if (path === "/api/auth/me") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const valid = token === "token:valid";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docflowEnabled: true, user: valid ? { id: "u-1" } : null }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "remote", path }));
  });
}

/** Порт, на котором уже никто не слушает: сервер СЭД «упал». */
async function deadPortUrl(): Promise<string> {
  const temporary = await listen((_req, res) => res.end());
  const url = temporary.baseUrl;
  await temporary.close();
  return url;
}

let remote: RunningApp;
let app: RunningApp;

beforeAll(async () => {
  remote = await remoteDocflow();
  app = await listen(await createApp({ docflowServerUrl: remote.baseUrl }));
});

afterAll(async () => {
  await app.close();
  await remote.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  remotePaths.length = 0;
});

describe("почта в режиме клиента обслуживает СЕРВЕР", () => {
  it("GET /api/emails уходит на сервер, локальная база не задействована", async () => {
    const res = await request(app.baseUrl, "GET", "/api/emails");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: "remote", path: "/api/emails" });
    expect(remotePaths).toContain("/api/emails");
    // Локальных писем в варианте А нет: их не должно быть и в обработке.
    expect(coreMocks.listEmailsWithAnalysis).not.toHaveBeenCalled();
  });

  it("карточка письма и вложение тоже идут на сервер", async () => {
    await request(app.baseUrl, "GET", "/api/emails/e-1");
    await request(app.baseUrl, "GET", "/api/emails/e-1/attachments/a-1/file");

    expect(remotePaths).toContain("/api/emails/e-1");
    expect(remotePaths).toContain("/api/emails/e-1/attachments/a-1/file");
    expect(coreMocks.getEmailView).not.toHaveBeenCalled();
    expect(coreMocks.listAttachments).not.toHaveBeenCalled();
  });

  it("настройки предприятия и ключ модели — на сервере, локальные настройки не меняются", async () => {
    const put = await request(app.baseUrl, "PUT", "/api/settings", { body: { "ai.model": "x" } });
    const ai = await request(app.baseUrl, "GET", "/api/ai/config");

    expect(put.status).toBe(200);
    expect(ai.status).toBe(200);
    expect(coreMocks.setSettingValue).not.toHaveBeenCalled();
    expect(coreMocks.getAiConfig).not.toHaveBeenCalled();
  });

  it("health остаётся открытым — иначе клиент не поймёт, жив ли он сам", async () => {
    const res = await request(app.baseUrl, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(remotePaths).not.toContain("/api/health");
  });
});

describe("личные вещи работника остаются в клиенте", () => {
  it("черновики обслуживаются локально и требуют подтверждённой сессии", async () => {
    const withoutToken = await request(app.baseUrl, "GET", "/api/drafts");
    expect(withoutToken.status).toBe(401);

    const res = await request(app.baseUrl, "GET", "/api/drafts", { token: "token:valid" });
    expect(res.status).toBe(200);
    expect(coreMocks.listDrafts).toHaveBeenCalled();
    // На сервер личные черновики не уезжают.
    expect(remotePaths).not.toContain("/api/drafts");
  });

  it("шаблоны тоже локальные", async () => {
    const res = await request(app.baseUrl, "GET", "/api/templates", { token: "token:valid" });
    expect(res.status).toBe(200);
    expect(coreMocks.listTemplates).toHaveBeenCalled();
    expect(remotePaths).not.toContain("/api/templates");
  });

  it("отозванная сессия закрывает и личные пути", async () => {
    const res = await request(app.baseUrl, "GET", "/api/drafts", { token: "token:revoked" });
    expect(res.status).toBe(401);
    expect(coreMocks.listDrafts).not.toHaveBeenCalled();
  });
});

describe("сервер недоступен: честная ошибка вместо пустоты", () => {
  it("почта отвечает 503 «сервер недоступен», а не пустым списком", async () => {
    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const res = await request(offline.baseUrl, "GET", "/api/emails", { token: "token:never-checked" });

      expect(res.status).toBe(503);
      expect(String((res.body as { error?: string }).error)).toContain("недоступен");
      expect(coreMocks.listEmailsWithAnalysis).not.toHaveBeenCalled();
    } finally {
      await offline.close();
    }
  }, 20000);

  it("при упавшем сервере личные черновики продолжают работать (сессия подтверждена ранее)", async () => {
    // Сессию подтверждаем у живого сервера: личные пути проверяют её сами.
    const confirmed = await request(app.baseUrl, "GET", "/api/drafts", { token: "token:valid" });
    expect(confirmed.status).toBe(200);

    // …ждём, пока истечёт срок кэша проверки (перепроверка пойдёт к упавшему серверу)…
    await sleep(Number(process.env.MAILSENSE_TEST_SESSION_CACHE_MS ?? 5200));

    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const mail = await request(offline.baseUrl, "GET", "/api/emails", { token: "token:valid" });
      const drafts = await request(offline.baseUrl, "GET", "/api/drafts", { token: "token:valid" });

      // Почта живёт на сервере — без него её нет, и это сказано прямо.
      expect(mail.status).toBe(503);
      // Личное работает: оно лежит в клиенте и от сервера не зависит.
      expect(drafts.status).toBe(200);
      expect(coreMocks.listDrafts).toHaveBeenCalled();
    } finally {
      await offline.close();
    }
  }, 30000);
});
