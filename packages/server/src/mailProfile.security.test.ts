/**
 * Личный профиль почты в клиентском режиме: не превращается ли запоминание пользователя
 * подтверждённой сессии в обход проверки (task-37).
 *
 * Что настоящее: приложение (`createApp` с `docflowServerUrl` → режим клиента), middleware
 * `attachUser`/`requireRemoteSession`, маршруты профиля, разбор cookie, порядок Express.
 * Удалённый СЭД подменён подставным `fetch` (в тестах его нет по определению), локальное ядро
 * профиля — спаи: видно, С КАКИМ КЛЮЧОМ маршрут читает и пишет профиль.
 *
 * ⚠️ Локальный `resolveToken` намеренно возвращает null: в клиентском режиме локальной базы
 * сессий нет, поэтому `req.user` обязан появиться ТОЛЬКО из подтверждённой удалённой сессии —
 * иначе тест проверял бы не тот механизм.
 *
 * ⚠️ Каждый тест берёт СВЕЖИЙ токен: кэш подтверждённых сессий живёт в модуле auth.ts и
 * переживает тесты, а таблица сессий удалённого сервера — общая. Иначе один тест «отравлял»
 * бы другой (проверено: именно так и вышло на первой версии).
 */
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { isProxiedPath } from "./proxy.js";

jest.mock("@mailsense/core", () => {
  const m = require("./testing/mocks.js").coreMockModule() as Record<string, unknown>;
  m.getMailProfile = jest.fn((key: string) => ({
    userId: key,
    displayName: "",
    signatureText: "",
    signatureEnabled: true,
    signaturePosition: "below",
    replyQuote: true,
    replyAttribution: "ru",
    updatedAt: null
  }));
  m.setMailProfile = jest.fn((key: string, patch: Record<string, unknown>) => ({ userId: key, ...patch }));
  m.MailProfileInputError = class MailProfileInputError extends Error {};
  return m;
});

jest.mock("@mailsense/docflow", () => {
  const m = require("./testing/mocks.js").docflowMockModule() as Record<string, unknown>;
  m.resolveToken = jest.fn(async () => null);
  return m;
});

const mockedCore = core as unknown as Record<string, jest.Mock>;
const REMOTE = "http://remote.stand.test";
/** Настоящий fetch: им стенд теста ходит в приложение. Подменяем только удалённый СЭД. */
const realFetch = globalThis.fetch.bind(globalThis);

interface RemoteUser { id: string; ldapUid?: string | null; fullName: string; permissions?: string[] }

const A: RemoteUser = { id: "u-a", ldapUid: "ivanov_ii", fullName: "Иванов И.И.", permissions: [] };
const B: RemoteUser = { id: "u-b", ldapUid: "petrova_ma", fullName: "Петрова М.А.", permissions: [] };
const C: RemoteUser = { id: "u-c", ldapUid: "", fullName: "Локальный Админ", permissions: [] };

/** Подставной удалённый СЭД: таблица сессий, режимы «недоступен» и «ошибка 500». */
class RemoteServer {
  sessions = new Map<string, RemoteUser>();
  down = false;
  fail500 = false;
  calls: Array<{ url: string }> = [];
  meRequests = 0;

  add(token: string, user: RemoteUser): void { this.sessions.set(token, user); }
  invalidate(token: string): void { this.sessions.delete(token); }

  handler = async (url: string | URL, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
    const u = String(url);
    // Всё, что не к серверу СЭД (в том числе обращения стенда к приложению), идёт настоящим fetch.
    if (!u.startsWith(REMOTE)) return realFetch(url as never, init as never);
    this.calls.push({ url: u });
    if (this.down) throw new TypeError("fetch failed: сетевая ошибка");
    if (this.fail500) return new Response("{}", { status: 500 });
    if (u.endsWith("/api/auth/me")) {
      this.meRequests++;
      const token = ((init?.headers ?? {}) as Record<string, string>).authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const user = this.sessions.get(token);
      if (!user) {
        return new Response(JSON.stringify({ error: "Требуется вход" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ docflowEnabled: true, user }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 404 });
  };
}

let remote: RemoteServer;
let app: RunningApp;
let nowMs = 1_000_000;
let seq = 0;
const TTL = 5000;

/** Свежий токен на тест: регистрируем сессию на удалённом сервере и возвращаем токен. */
function fresh(user: RemoteUser): string {
  const token = "tok-" + ++seq;
  remote.add(token, user);
  return token;
}
/** Токен, которого удалённый сервер НЕ знает (подделка/просроченная cookie). */
function unknownToken(): string {
  return "unknown-" + ++seq;
}

beforeAll(async () => {
  remote = new RemoteServer();
  (globalThis as unknown as { fetch: unknown }).fetch = remote.handler as unknown as typeof fetch;
  app = await listen(await createApp({ docflowServerUrl: REMOTE }));
});

afterAll(async () => {
  await app.close();
  // Возвращаем настоящий fetch: подмена не должна переживать файл теста.
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
});

beforeEach(() => {
  nowMs += 10 * TTL; // «остужаем» кэш: всё, что подтверждалось раньше, старше TTL
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
  remote.down = false;
  remote.fail500 = false;
  remote.calls = [];
  remote.meRequests = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const get = (token: string) => request(app.baseUrl, "GET", "/api/mail-profile", { token });
const put = (token: string, body: unknown) => request(app.baseUrl, "PUT", "/api/mail-profile", { token, body });

describe("профиль почты · доступ без сессии и с подделанной cookie", () => {
  it("без cookie — 401 на чтение и на запись, локальные данные не тронуты", async () => {
    const read = await request(app.baseUrl, "GET", "/api/mail-profile");
    expect(read.status).toBe(401);
    const write = await request(app.baseUrl, "PUT", "/api/mail-profile", { body: { signatureText: "взлом" } });
    expect(write.status).toBe(401);
    expect(mockedCore.getMailProfile).not.toHaveBeenCalled();
    expect(mockedCore.setMailProfile).not.toHaveBeenCalled();
  });

  it("подделанный (неизвестный серверу) токен — 401 и запрос к серверу был ровно один", async () => {
    const res = await get(unknownToken());
    expect(res.status).toBe(401);
    expect(mockedCore.getMailProfile).not.toHaveBeenCalled();
    expect(remote.meRequests).toBe(1);
  });

  it("профиль не отдаётся и по PUT: подделанный токен не пишет ничего", async () => {
    const res = await put(unknownToken(), { signatureText: "чужое" });
    expect(res.status).toBe(401);
    expect(mockedCore.setMailProfile).not.toHaveBeenCalled();
  });

  it("сервер СЭД ответил 500 — это 503 (не «вошёл» и не «нет прав»)", async () => {
    const token = fresh(A);
    remote.fail500 = true;
    const res = await get(token);
    expect(res.status).toBe(503);
    expect(mockedCore.getMailProfile).not.toHaveBeenCalled();
  });

  it("токен не подтверждали, сервер недоступен — 503: «уронить» сервер недостаточно, чтобы войти", async () => {
    const token = fresh(A);
    remote.down = true;
    const res = await get(token);
    expect(res.status).toBe(503);
    expect(mockedCore.getMailProfile).not.toHaveBeenCalled();
  });
});

describe("профиль почты · профиль только свой", () => {
  it("ключ — учётная запись владельца токена (LDAP-логин), у другого токена — своя", async () => {
    const a = await get(fresh(A));
    expect(a.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("ivanov_ii");

    const b = await get(fresh(B));
    expect(b.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("petrova_ma");
  });

  it("без LDAP-учётки ключом становится id пользователя", async () => {
    const res = await get(fresh(C));
    expect(res.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("u-c");
  });

  it("чужой ключ в query и в теле не подменяет владельца — ни на чтении, ни на записи", async () => {
    const token = fresh(A);
    const read = await request(app.baseUrl, "GET", "/api/mail-profile?userId=petrova_ma", { token });
    expect(read.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("ivanov_ii");

    const write = await put(token, { userId: "petrova_ma", signatureText: "чужое" });
    expect(write.status).toBe(200);
    expect(mockedCore.setMailProfile).toHaveBeenLastCalledWith("ivanov_ii", expect.objectContaining({ signatureText: "чужое" }));
  });
});

describe("профиль почты · офлайн-путь не расширяет права", () => {
  it("в пределах TTL сервер не опрашивается вовсе, профиль — владельца кэша", async () => {
    const token = fresh(A);
    await get(token); // сессия подтверждена
    const asked = remote.meRequests;
    remote.down = true;
    nowMs += TTL - 1;
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(remote.meRequests).toBe(asked); // из кэша, без обращения к серверу
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("ivanov_ii");
  });

  it("TTL истёк и сервер недоступен: подтверждённая сессия работает, незнакомая — 503", async () => {
    const known = fresh(A);
    await get(known);
    remote.down = true;
    nowMs += TTL + 1;

    const res = await get(known);
    expect(res.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("ivanov_ii");

    // Токен, которого сервер не знает и который никогда не подтверждался.
    const foreign = await get(unknownToken());
    expect(foreign.status).toBe(503);
    expect(mockedCore.getMailProfile).not.toHaveBeenCalledWith("petrova_ma");
  });

  it("сервер вернулся и сказал «сессии нет» — кэш больше не спасает", async () => {
    const token = fresh(A);
    await get(token);
    remote.down = true;
    nowMs += TTL + 1;
    expect((await get(token)).status).toBe(200);

    remote.down = false;
    remote.invalidate(token);
    nowMs += TTL + 1;
    expect((await get(token)).status).toBe(401);
  });
});

describe("профиль почты · окно после разлогина (остаточный риск с границей)", () => {
  it("сразу после разлогина кэш ещё пускает (<= TTL), после TTL — 401; чужих данных окно не открывает", async () => {
    const tokenA = fresh(A);
    const tokenB = fresh(B);
    await get(tokenA);
    await get(tokenB);
    remote.invalidate(tokenA); // сервер обработал разлогин/отзыв сессии

    const withinTtl = await get(tokenA);
    expect(withinTtl.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("ivanov_ii"); // и только его профиль

    nowMs += TTL;
    expect((await get(tokenA)).status).toBe(401);

    const other = await get(tokenB);
    expect(other.status).toBe(200);
    expect(mockedCore.getMailProfile).toHaveBeenLastCalledWith("petrova_ma");
  });

  it("окно не больше TTL: на TTL+1 мс доступа уже нет", async () => {
    const token = fresh(A);
    await get(token);
    remote.invalidate(token);
    nowMs += TTL + 1;
    expect((await get(token)).status).toBe(401);
  });
});

describe("профиль почты · приватность: данные не уезжают на сервер СЭД", () => {
  it("/api/mail-profile не проксируется (и подпути тоже)", () => {
    expect(isProxiedPath("/api/mail-profile")).toBe(false);
    expect(isProxiedPath("/api/mail-profile/extra")).toBe(false);
    expect(isProxiedPath("/api/auth/me")).toBe(true);
    expect(isProxiedPath("/api/emails")).toBe(true);
  });

  it("PUT с подписью не порождает ни одного запроса к серверу СЭД с этими данными", async () => {
    const MARKER = "ZZPROBE-SIGN-37-private-signature";
    const token = fresh(A);
    const res = await put(token, { signatureText: MARKER, displayName: "Иванов И.И." });
    expect(res.status).toBe(200);

    // Ни один уходящий запрос не адресован профилю и не несёт маркер: только проверка сессии.
    for (const call of remote.calls) expect(call.url.endsWith("/api/auth/me")).toBe(true);
    expect(remote.calls.filter((c) => c.url.includes("mail-profile"))).toEqual([]);
    expect(mockedCore.setMailProfile).toHaveBeenCalledWith("ivanov_ii", expect.objectContaining({ signatureText: MARKER }));
  });
});
