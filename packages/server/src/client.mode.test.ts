import http from "node:http";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, sleep, type RunningApp } from "./testing/harness.js";
import { __remoteSessionCacheForTests } from "./auth.js";

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

/**
 * Удалённый СЭД: /api/auth/me подтверждает только известные токены, остальное отдаёт
 * как «серверное». `revoked` позволяет тесту «отозвать» сессию на живой стороне.
 */
const remotePaths: string[] = [];
// ⚠️ Настоящий /api/auth/me отдаёт ещё роли и права — пусть отдаёт и мок: иначе тест
// на форму кэша ничего бы не ловил (нечего было бы отбрасывать).
const remoteUsers = new Map<string, Record<string, unknown>>([
  ["token:valid", { id: "u-1", ldapUid: "ivanov_ii", fullName: "Иванов И.И.", roles: ["secretary"], permissions: ["journal.view"] }],
  ["token:petrova", { id: "u-2", ldapUid: "petrova_ma", fullName: "Петрова М.А.", roles: ["executor"], permissions: ["task.view"] }]
]);
const revoked = new Set<string>();
async function remoteDocflow(): Promise<RunningApp> {
  return listen((req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    remotePaths.push(path);
    if (path === "/api/auth/me") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const user = revoked.has(token) ? null : remoteUsers.get(token) ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docflowEnabled: true, user }));
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

  it("личный профиль почты остаётся в клиенте и на сервер не уходит", async () => {
    // Личные настройки работника (Р18) — то же правило, что у черновиков и шаблонов:
    // в клиентском режиме их обслуживает LOCAL обработчик, а не сервер СЭД.
    const get = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:valid" });
    const put = await request(app.baseUrl, "PUT", "/api/mail-profile", {
      token: "token:valid",
      body: { displayName: "Иванов И.И., аппарат" }
    });

    expect(get.status).toBe(200);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ displayName: "Иванов И.И., аппарат" });
    // Ключ — учётка работника из ПОДТВЕРЖДЁННОЙ удалённой сессии (не id и не ящик).
    expect(coreMocks.getMailProfile).toHaveBeenCalledWith("ivanov_ii");
    expect(coreMocks.setMailProfile).toHaveBeenCalledWith("ivanov_ii", { displayName: "Иванов И.И., аппарат" });
    // На удалённый сервер профиль не уезжает вообще.
    expect(remotePaths).not.toContain("/api/mail-profile");
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

describe("кэш подтверждённой сессии не даёт доступа в обход проверки", () => {
  it("незнакомая сессия при упавшем сервере НЕ получает профиль — 503, ядро не спрашивают", async () => {
    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const res = await request(offline.baseUrl, "GET", "/api/mail-profile", { token: "token:never-seen" });

      expect(res.status).toBe(503);
      expect(coreMocks.getMailProfile).not.toHaveBeenCalled();
    } finally {
      await offline.close();
    }
  }, 20000);

  it("кэш не смешивает работников: у каждого токена свой профиль", async () => {
    const ivanov = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:valid" });
    const petrova = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:petrova" });

    expect(ivanov.status).toBe(200);
    expect(petrova.status).toBe(200);
    expect(coreMocks.getMailProfile).toHaveBeenNthCalledWith(1, "ivanov_ii");
    expect(coreMocks.getMailProfile).toHaveBeenNthCalledWith(2, "petrova_ma");
  });

  it("отозванная сессия закрывает доступ и НЕ остаётся в кэше", async () => {
    // Сначала сессию подтверждаем (она попадает в кэш)…
    const before = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:petrova" });
    expect(before.status).toBe(200);

    // …затем сервер её отзывает, и по истечении срока кэша запрос обязан получить отказ.
    revoked.add("token:petrova");
    await sleep(Number(process.env.MAILSENSE_TEST_SESSION_CACHE_MS ?? 5200));
    const rejected = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:petrova" });
    expect(rejected.status).toBe(401);

    // И главное: отозванный токен не должен «оживать» на упавшем сервере из старого кэша.
    const offline = await listen(await createApp({ docflowServerUrl: await deadPortUrl() }));
    try {
      const res = await request(offline.baseUrl, "GET", "/api/mail-profile", { token: "token:petrova" });
      expect(res.status).toBe(503);
      expect(coreMocks.getMailProfile).toHaveBeenCalledTimes(1); // только первый, успешный вызов
    } finally {
      await offline.close();
    }
  }, 30000);
});

describe("T45: в кэше подтверждённой сессии нет ролей и прав", () => {
  it("запись кэша — ровно id, логин и ФИО (роли и права сервера отброшены)", async () => {
    __remoteSessionCacheForTests().clear();

    const res = await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:valid" });

    expect(res.status).toBe(200);
    const entry = __remoteSessionCacheForTests().get("token:valid");
    expect(entry).toBeDefined();
    expect(entry?.user).toEqual({ id: "u-1", ldapUid: "ivanov_ii", fullName: "Иванов И.И." });
    expect(Object.keys(entry?.user ?? {}).sort()).toEqual(["fullName", "id", "ldapUid"]);
  });

  it("поведение не изменилось: ключ профиля по-прежнему логин каталога", async () => {
    __remoteSessionCacheForTests().clear();
    // Предыдущий тест этого файла отзывает token:petrova — здесь он снова действующий.
    revoked.delete("token:petrova");

    await request(app.baseUrl, "GET", "/api/mail-profile", { token: "token:petrova" });

    expect(coreMocks.getMailProfile).toHaveBeenCalledWith("petrova_ma");
  });
});
