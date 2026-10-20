import express from "express";
import http from "node:http";
import { createDocflowProxy, isProxiedPath } from "./proxy.js";
import { listen, request, sleep, stillAlive, type RunningApp } from "./testing/harness.js";

/**
 * Устойчивость прокси к серверу документооборота.
 *
 * Апстрим — настоящий HTTP-сервер: он умеет оборвать соединение посередине ответа,
 * замолчать и не отвечать вовсе. Именно на обрыве прежний код ронял процесс:
 * поток ответа отдавался в res без обработчика ошибок.
 */

function proxyApp(baseUrl: string, timeoutMs = 2000): express.Express {
  const app = express();
  app.use(createDocflowProxy({ baseUrl, timeoutMs }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  return app;
}

/** Апстрим, который отдаёт заголовки и часть тела, а потом рвёт соединение. */
async function abortingUpstream(): Promise<RunningApp> {
  return listen((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!req.url?.startsWith("/api/docflow")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"items":[');
    setTimeout(() => res.socket?.destroy(), 20);
  });
}

/** Апстрим, который принимает запрос и молчит. */
async function silentUpstream(): Promise<RunningApp> {
  return listen(() => {
    /* намеренно не отвечаем */
  });
}

async function healthyUpstream(): Promise<RunningApp> {
  return listen((_req: http.IncomingMessage, res: http.ServerResponse) => {
    // Две cookie: перебор заголовков склеил бы их в одну строку — это и проверяем.
    res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ regNumber: "вх1" }));
  });
}

/** Порт, на котором уже никто не слушает. */
async function deadPortUrl(): Promise<string> {
  const temporary = await listen((_req, res) => res.end());
  const url = temporary.baseUrl;
  await temporary.close();
  return url;
}

describe("прокси к серверу документооборота", () => {
  it("ответ апстрима доходит целиком: статус, тело, заголовки", async () => {
    const upstream = await healthyUpstream();
    const app = await listen(proxyApp(upstream.baseUrl));
    try {
      const res = await request(app.baseUrl, "GET", "/api/docflow/journal");
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ regNumber: "вх1" });
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("заголовки Set-Cookie переносятся по отдельности", async () => {
    const upstream = await healthyUpstream();
    const app = await listen(proxyApp(upstream.baseUrl));
    try {
      const res = await request(app.baseUrl, "GET", "/api/auth/status");
      expect(res.headers.getSetCookie().sort()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("обрыв апстрима в середине ответа не роняет процесс", async () => {
    const upstream = await abortingUpstream();
    const app = await listen(proxyApp(upstream.baseUrl));
    try {
      // Клиент не получает ответа целиком — это ожидаемо: соединение оборвано.
      await expect(request(app.baseUrl, "GET", "/api/docflow/journal")).rejects.toThrow();
      await sleep(100);
      // А процесс обязан быть жив: локальная почта работает и без сервера документооборота.
      expect(await stillAlive(app.baseUrl)).toBe(true);
    } finally {
      await app.close();
      await upstream.close();
    }
  }, 10000);

  it("молчащий апстрим обрывается по таймауту с понятным текстом", async () => {
    const upstream = await silentUpstream();
    const app = await listen(proxyApp(upstream.baseUrl, 200));
    try {
      const res = await request(app.baseUrl, "GET", "/api/docflow/journal");
      expect(res.status).toBe(503);
      expect(String((res.body as { error?: string }).error)).toContain("истёк таймаут");
    } finally {
      await app.close();
      await upstream.close();
    }
  }, 10000);

  it("недоступный сервер документооборота — 503, локальные маршруты работают", async () => {
    const app = await listen(proxyApp(await deadPortUrl()));
    try {
      const res = await request(app.baseUrl, "GET", "/api/docflow/journal");
      expect(res.status).toBe(503);
      expect(String((res.body as { error?: string }).error)).toContain("недоступен");
      expect(await stillAlive(app.baseUrl)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("чужие пути прокси не трогает — уходят дальше по стеку", async () => {
    const upstream = await healthyUpstream();
    const app = await listen(proxyApp(upstream.baseUrl));
    try {
      const res = await request(app.baseUrl, "GET", "/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    } finally {
      await app.close();
      await upstream.close();
    }
  });
});

/**
 * Режим клиента: что уходит на сервер, а что остаётся личным.
 *
 * Живая жалоба заказчика: умолчания почтового сервера не доходили до работника на другом
 * компьютере — путь не был в списке прокси, и каждый экземпляр приложения хранил их локально.
 */
describe("какие пути в режиме клиента обслуживает сервер", () => {
  it("умолчания почты — настройка предприятия, значит сервер", () => {
    expect(isProxiedPath("/api/mail-defaults")).toBe(true);
  });

  it("личные вещи работника остаются локальными", () => {
    // Профиль почты, черновики и шаблоны вводит сам человек — на сервер они не уезжают.
    expect(isProxiedPath("/api/mail-profile")).toBe(false);
    expect(isProxiedPath("/api/drafts")).toBe(false);
    expect(isProxiedPath("/api/templates")).toBe(false);
  });

  it("префикс не ловит чужие пути по началу строки", () => {
    // /api/mail-profile не должен считаться продолжением /api/emails и наоборот.
    expect(isProxiedPath("/api/emails")).toBe(true);
    expect(isProxiedPath("/api/mail-profile-extra")).toBe(false);
  });
});
