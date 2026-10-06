import http from "node:http";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, sleep, type RunningApp } from "./testing/harness.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Режим клиента: почта локальная, документооборот — на удалённом сервере.
 *
 * ⚠️ Локальной базы СЭД здесь нет по определению, поэтому requirePermission считает
 * документооборот выключенным и пропускает всех. Значит, локальные маршруты (почта,
 * вложения, настройки, ключ модели) обязаны проверять сессию сами — у того сервера,
 * который её выдал. Иначе достаточно открыть порт в сеть, чтобы читать чужую почту.
 *
 * Отдельно проверяем обратную сторону: когда сервер недоступен, локальная почта
 * обязана продолжать работать (продуктовое требование «почта работает без СЭД»).
 */

const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

/** Удалённый СЭД: сессию принимает только токен token:valid. */
async function remoteDocflow(): Promise<RunningApp> {
  return listen((req: http.IncomingMessage, res: http.ServerResponse) => {
    if ((req.url ?? "").split("?")[0] === "/api/auth/me") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const valid = token === "token:valid";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docflowEnabled: true, user: valid ? { id: "u-1" } : null }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
}

/** Порт, на котором уже никто не слушает: сервер документооборота «упал». */
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
});

describe("режим клиента: локальный API без сессии закрыт", () => {
  it("письма без сессии не отдаются", async () => {
    const res = await request(app.baseUrl, "GET", "/api/emails");

    expect(res.status).toBe(401);
    expect(coreMocks.listEmailsWithAnalysis).not.toHaveBeenCalled();
  });

  it("ключ модели без сессии не отдаётся", async () => {
    const res = await request(app.baseUrl, "GET", "/api/ai/config");

    expect(res.status).not.toBe(200);
    expect(coreMocks.getAiConfig).not.toHaveBeenCalled();
  });

  it("настройки без сессии не меняются", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/settings", { body: { "ai.model": "x" } });

    expect(res.status).toBe(401);
    expect(coreMocks.setSettingValue).not.toHaveBeenCalled();
  });

  it("health остаётся открытым — иначе клиент не поймёт, жив ли сервер", async () => {
    const res = await request(app.baseUrl, "GET", "/api/health");
    expect(res.status).toBe(200);
  });

  it("сессия, подтверждённая удалённым СЭД, пускает к локальной почте", async () => {
    const res = await request(app.baseUrl, "GET", "/api/emails", { token: "token:valid" });

    expect(res.status).toBe(200);
    expect(coreMocks.listEmailsWithAnalysis).toHaveBeenCalled();
  });

  it("отозванная сессия отклоняется: сервер ответил user: null", async () => {
    const res = await request(app.baseUrl, "GET", "/api/emails", { token: "token:revoked" });
    expect(res.status).toBe(401);
  });
});

describe("режим клиента: сервер документооборота недоступен", () => {
  it("незнакомая сессия не пускается в почту — 503, а не открытый API", async () => {
    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const res = await request(offline.baseUrl, "GET", "/api/emails", { token: "token:never-checked" });

      expect(res.status).toBe(503);
      expect(coreMocks.listEmailsWithAnalysis).not.toHaveBeenCalled();
    } finally {
      await offline.close();
    }
  }, 20000);

  it("ранее подтверждённая сессия работает офлайн: почта локальная", async () => {
    // Сессию подтверждаем у живого сервера…
    const confirmed = await request(app.baseUrl, "GET", "/api/emails", { token: "token:valid" });
    expect(confirmed.status).toBe(200);

    // …ждём, пока истечёт срок кэша проверки (перепроверка пойдёт к упавшему серверу)…
    await sleep(Number(process.env.MAILSENSE_TEST_SESSION_CACHE_MS ?? 5200));

    // …и при недоступном сервере почта обязана открыться: она лежит локально.
    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const res = await request(offline.baseUrl, "GET", "/api/emails", { token: "token:valid" });
      expect(res.status).toBe(200);
    } finally {
      await offline.close();
    }
  }, 30000);
});
