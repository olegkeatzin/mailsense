import express from "express";
import { createDocflowProxy } from "./proxy.js";
import { listen, request, type RunningApp } from "./testing/harness.js";

/**
 * Граница тонкого клиента (task-22): что уезжает на сервер СЭД, а что остаётся локально.
 *
 * В варианте А почта живёт НА СЕРВЕРЕ (служебные ящики аппарата), поэтому клиент обязан
 * проксировать почтовые пути: иначе аппарат видит очередь писем с сервера, а открыть само
 * письмо не может — оно «локальное» и его там нет. Личными остаются только черновики,
 * шаблоны и будущий профиль почты работника.
 */
const PROXIED = [
  "/api/emails",
  "/api/emails/e-1",
  "/api/emails/e-1/attachments/a-1/file",
  "/api/emails/send",
  "/api/accounts",
  "/api/accounts/acc-1",
  "/api/threads",
  "/api/analysis/e-1",
  "/api/import",
  "/api/compose-template",
  "/api/settings",
  "/api/ai/config",
  "/api/ai/prompt",
  // Уже проксировались: журнал, пользователи, каталог, архив года.
  "/api/docflow/journal",
  "/api/auth/me",
  "/api/directory/status",
  "/api/journal/export"
];

const LOCAL = ["/api/drafts", "/api/drafts/d-1", "/api/templates", "/api/mail-profile", "/api/health"];

/** Апстрим, который запоминает, что до него дошло, и отвечает своей меткой. */
async function recordingUpstream(): Promise<{ app: RunningApp; seen: string[] }> {
  const seen: string[] = [];
  const app = await listen((req, res) => {
    seen.push((req.method ?? "GET") + " " + (req.url ?? ""));
    // Тело читаем: иначе на POST/PUT соединение сбрасывается и запрос «не доходит».
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "remote" }));
  });
  return { app, seen };
}

/** Приложение как в режиме клиента: прокси + локальные обработчики личных путей. */
function clientLikeApp(baseUrl: string): express.Express {
  const app = express();
  app.use(createDocflowProxy({ baseUrl, timeoutMs: 2000 }));
  for (const path of LOCAL) {
    app.all(path, (_req, res) => res.json({ from: "local", path }));
  }
  return app;
}

/** Порт, на котором уже никто не слушает: сервер СЭД «упал». */
async function deadPortUrl(): Promise<string> {
  const temporary = await listen((_req, res) => res.end());
  const url = temporary.baseUrl;
  await temporary.close();
  return url;
}

describe("почтовые пути уходят на сервер СЭД", () => {
  it.each(PROXIED)("%s обслуживает сервер, а не локальный обработчик", async (path) => {
    const upstream = await recordingUpstream();
    const app = await listen(clientLikeApp(upstream.app.baseUrl));
    try {
      const res = await request(app.baseUrl, "GET", path);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ from: "remote" });
      expect(upstream.seen).toEqual(["GET " + path]);
    } finally {
      await app.close();
      await upstream.app.close();
    }
  });

  it("запрос с телом и методом уходит на сервер как есть (PUT /api/settings)", async () => {
    const upstream = await recordingUpstream();
    const app = await listen(clientLikeApp(upstream.app.baseUrl));
    try {
      const res = await request(app.baseUrl, "PUT", "/api/settings", { body: { "ai.model": "x" } });

      expect(res.status).toBe(200);
      expect(upstream.seen).toEqual(["PUT /api/settings"]);
    } finally {
      await app.close();
      await upstream.app.close();
    }
  });

  it("отправка письма с вложением идёт на сервер (POST /api/emails/send)", async () => {
    const upstream = await recordingUpstream();
    const app = await listen(clientLikeApp(upstream.app.baseUrl));
    try {
      const res = await request(app.baseUrl, "POST", "/api/emails/send", {
        body: { accountId: "acc-1", to: [{ address: "a@b.c" }], bodyText: "текст" }
      });

      expect(res.status).toBe(200);
      expect(upstream.seen).toEqual(["POST /api/emails/send"]);
    } finally {
      await app.close();
      await upstream.app.close();
    }
  });
});

describe("личные пути остаются в клиенте", () => {
  it.each(LOCAL)("%s обслуживается локально и на сервер не уходит", async (path) => {
    const upstream = await recordingUpstream();
    const app = await listen(clientLikeApp(upstream.app.baseUrl));
    try {
      const res = await request(app.baseUrl, "GET", path);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ from: "local" });
      // Ни одного запроса на сервер: личные данные работника туда не уезжают.
      expect(upstream.seen).toEqual([]);
    } finally {
      await app.close();
      await upstream.app.close();
    }
  });
});

describe("недоступный сервер: честная ошибка вместо пустоты", () => {
  it("почтовый путь отвечает 503 с понятным текстом (не 200 с пустым списком)", async () => {
    const app = await listen(clientLikeApp(await deadPortUrl()));
    try {
      const res = await request(app.baseUrl, "GET", "/api/emails");

      expect(res.status).toBe(503);
      expect(String((res.body as { error?: string }).error)).toContain("недоступен");
    } finally {
      await app.close();
    }
  });

  it("личный путь при том же недоступном сервере продолжает работать", async () => {
    const app = await listen(clientLikeApp(await deadPortUrl()));
    try {
      const res = await request(app.baseUrl, "GET", "/api/drafts");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ from: "local" });
    } finally {
      await app.close();
    }
  });
});
