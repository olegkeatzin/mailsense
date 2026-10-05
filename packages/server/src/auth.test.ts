import express from "express";
import {
  attachUser,
  parseCookies,
  requireAdmin,
  requireAuth,
  requirePermission,
  sessionCookieOptions
} from "./auth.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { docflowMockModule, testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

import * as docflow from "@mailsense/docflow";

const mocked = docflow as unknown as {
  isDocflowEnabled: jest.Mock;
  resolveToken: jest.Mock;
  __sessions: Map<string, TestUser>;
};

/** Небольшое приложение с теми же middleware, что и настоящее. */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use(requireAuth);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/status", (_req, res) => res.json({ enabled: true }));
  app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));
  app.get("/api/private", (req, res) => res.json({ userId: req.user?.id ?? null, token: req.sessionToken }));
  app.put("/api/settings", requirePermission("settings.manage"), (_req, res) => res.json({ ok: true }));
  app.put("/api/users/:id/roles", requireAdmin, (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.send("<html>spa</html>"));
  return app;
}

let app: RunningApp;

beforeAll(async () => {
  mocked.__sessions.set("token:admin", testUser("u-admin", ["admin"]));
  mocked.__sessions.set("token:executor", testUser("u-executor", ["executor"]));
  mocked.__sessions.set("token:manager", testUser("u-manager", ["manager"]));
  app = await listen(buildApp());
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mocked.isDocflowEnabled.mockResolvedValue(true);
  mocked.resolveToken.mockImplementation(async (token: string | null) =>
    token ? mocked.__sessions.get(token) ?? null : null
  );
  mocked.isDocflowEnabled.mockClear();
});

describe("parseCookies", () => {
  it("разбирает пары и декодирует значения", () => {
    expect(parseCookies("a=1; mailsense_session=token%3Aadmin")).toEqual({
      a: "1",
      mailsense_session: "token:admin"
    });
  });

  it("пропускает мусор и пустой заголовок", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("мусор; =пусто; ok=1")).toEqual({ ok: "1" });
  });
});

describe("requireAuth", () => {
  it("401 без сессии на защищённом маршруте", async () => {
    const res = await request(app.baseUrl, "GET", "/api/private");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Требуется вход в систему" });
  });

  it("пускает с сессией и отдаёт пользователя обработчику", async () => {
    const res = await request(app.baseUrl, "GET", "/api/private", { token: "token:admin" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "u-admin", token: "token:admin" });
  });

  it("публичные маршруты отвечают без сессии: health, status, me", async () => {
    for (const path of ["/api/health", "/api/auth/status", "/api/auth/me"]) {
      const res = await request(app.baseUrl, "GET", path);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it("статика SPA отдаётся до входа — иначе экран входа не загрузится", async () => {
    const res = await request(app.baseUrl, "GET", "/");
    expect(res.status).toBe(200);
  });

  it("при выключенном документообороте работает однопользовательский режим", async () => {
    mocked.isDocflowEnabled.mockResolvedValue(false);
    const res = await request(app.baseUrl, "GET", "/api/private");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: null, token: null });
  });

  it("недоступная база документооборота — 503, а не «открыто всем»", async () => {
    mocked.isDocflowEnabled.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:55432"));
    const anonymous = await request(app.baseUrl, "GET", "/api/private");
    expect(anonymous.status).toBe(503);
    const withRole = await request(app.baseUrl, "PUT", "/api/settings", {
      token: "token:admin",
      body: { "ai.model": "x" }
    });
    expect(withRole.status).toBe(503);
  });

  it("ошибка разбора токена не ломает запрос: пользователь просто не определён", async () => {
    mocked.resolveToken.mockRejectedValue(new Error("база упала"));
    const res = await request(app.baseUrl, "GET", "/api/private", { token: "token:admin" });
    expect(res.status).toBe(401);
  });
});

describe("requirePermission / requireAdmin", () => {
  it("401 без сессии, 403 без права, 200 с правом", async () => {
    const anonymous = await request(app.baseUrl, "PUT", "/api/settings", { body: {} });
    expect(anonymous.status).toBe(401);

    const withoutRight = await request(app.baseUrl, "PUT", "/api/settings", {
      token: "token:executor",
      body: {}
    });
    expect(withoutRight.status).toBe(403);
    expect(withoutRight.body).toEqual({ error: "Недостаточно прав для этого действия" });

    const withRight = await request(app.baseUrl, "PUT", "/api/settings", {
      token: "token:admin",
      body: {}
    });
    expect(withRight.status).toBe(200);
  });

  it("право берётся из ролей docflow: исполнителю недоступно управление пользователями", async () => {
    const executor = await request(app.baseUrl, "PUT", "/api/users/u-1/roles", {
      token: "token:executor",
      body: { roleIds: ["admin"] }
    });
    expect(executor.status).toBe(403);

    const manager = await request(app.baseUrl, "PUT", "/api/users/u-1/roles", {
      token: "token:manager",
      body: { roleIds: ["admin"] }
    });
    expect(manager.status).toBe(403);

    const admin = await request(app.baseUrl, "PUT", "/api/users/u-1/roles", {
      token: "token:admin",
      body: { roleIds: ["admin"] }
    });
    expect(admin.status).toBe(200);
  });

  it("при выключенном документообороте права не проверяются (устаревший режим)", async () => {
    mocked.isDocflowEnabled.mockResolvedValue(false);
    const res = await request(app.baseUrl, "PUT", "/api/settings", { token: null, body: {} });
    expect(res.status).toBe(200);
  });
});

describe("токен сессии", () => {
  it("Bearer важнее cookie", async () => {
    const res = await request(app.baseUrl, "GET", "/api/private", {
      headers: { authorization: "Bearer token:admin", cookie: "mailsense_session=token:executor" }
    });
    expect(res.body.userId).toBe("u-admin");
  });

  it("cookie сессии работает, когда заголовка Authorization нет", async () => {
    const res = await request(app.baseUrl, "GET", "/api/private", {
      headers: { cookie: "mailsense_session=token:executor" }
    });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("u-executor");
  });
});

describe("sessionCookieOptions", () => {
  const reqOf = (headers: Record<string, string>) =>
    ({ secure: false, headers }) as unknown as express.Request;

  it("cookie сессии — httpOnly, lax, на весь сайт", () => {
    const options = sessionCookieOptions(reqOf({}), 3600_000);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false, maxAge: 3600_000 });
  });

  it("за прокси с https cookie помечается secure", () => {
    expect(sessionCookieOptions(reqOf({ "x-forwarded-proto": "https" }), 1000).secure).toBe(true);
  });
});
