import type express from "express";
import {
  SESSION_COOKIE,
  hasPermission,
  isDocflowEnabled,
  resolveToken,
  type AuthUser,
  type Permission
} from "@mailsense/docflow";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Пользователь сессии; null в устаревшем однопользовательском режиме. */
      user: AuthUser | null;
      sessionToken: string | null;
      /** Не удалось проверить сессию: база документооборота недоступна. */
      authLookupError: Error | null;
    }
  }
}

/**
 * Разбор Cookie без зависимости cookie-parser: нужен ровно один заголовок.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Токен сессии: приоритет у Bearer (тесты/CLI), иначе cookie. */
function tokenOf(req: express.Request): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim() || null;
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export async function attachUser(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const token = tokenOf(req);
  req.sessionToken = token;
  try {
    // База документооборота теперь PostgreSQL, поэтому проверка сессии асинхронная.
    req.user = await resolveToken(token);
    req.authLookupError = null;
  } catch (err) {
    // ⚠️ Это НЕ «сессии нет»: база документооборота не ответила. Отдай мы здесь 401 —
    // кратковременный сбой PostgreSQL выбрасывал бы всех вошедших из системы, и человек
    // лечил бы несуществующую проблему со входом. Ошибку запоминаем: requireAuth и
    // requirePermission ответят 503 «база недоступна».
    req.user = null;
    req.authLookupError = err as Error;
  }
  next();
}

/**
 * Включён ли документооборот. Настройка лежит в PostgreSQL, поэтому чтение
 * асинхронное; недоступность базы трактуем как отказ, а не как «выключено» —
 * иначе защищённый API молча открылся бы всем.
 */
async function docflowOn(res: express.Response): Promise<boolean | null> {
  try {
    return await isDocflowEnabled();
  } catch (err) {
    res.status(503).json({ error: "База документооборота недоступна: " + (err as Error).message });
    return null;
  }
}

/**
 * Маршруты, доступные без входа: состояние входа, сам вход, health.
 * Всё остальное при включённом СЭД требует аутентификации.
 */
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  // Это проба сессии, а не защищённый ресурс: клиент должен получать 200
  // с user=null, а не 401, иначе «не залогинен» приходит через исключение.
  "/api/auth/me"
]);

export async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  // Документооборот выключен — приложение работает как раньше, в однопользовательском режиме.
  const enabled = await docflowOn(res);
  if (enabled === null) return;
  if (!enabled) {
    req.user = req.user ?? null;
    return next();
  }
  // Статика SPA (index.html и бандлы) обязана отдаваться до входа: иначе браузер
  // получит 401 на «/» и экран входа просто не загрузится. Данных там нет —
  // один HTML-каркас, который сам сходит за /api/auth/me.
  if (!req.path.startsWith("/api/")) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.authLookupError) {
    res.status(503).json({ error: "База документооборота недоступна: " + req.authLookupError.message });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: "Требуется вход в систему" });
    return;
  }
  next();
}

/** Проверка права. В устаревшем режиме (СЭД выключен) права не проверяются. */
export function requirePermission(permission: Permission) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const enabled = await docflowOn(res);
    if (enabled === null) return;
    if (!enabled) return next();
    // База не ответила при проверке сессии — это 503, а не «нет прав» и не «нет входа».
    if (req.authLookupError) {
      res.status(503).json({ error: "База документооборота недоступна: " + req.authLookupError.message });
      return;
    }
    if (!req.user) {
      res.status(401).json({ error: "Требуется вход в систему" });
      return;
    }
    if (!hasPermission(req.user, permission)) {
      res.status(403).json({ error: "Недостаточно прав для этого действия" });
      return;
    }
    next();
  };
}

/**
 * Проверка «подходит любое из прав».
 *
 * Нужна там, где действие разрешено двум разным ролям по разным основаниям: справочник
 * исполнителей нужен и тому, кто создаёт поручения (аппарат, руководитель), и тому, кто
 * их подписывает (он вправе назначить исполнителя прямо при утверждении, Р8).
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const enabled = await docflowOn(res);
    if (enabled === null) return;
    if (!enabled) return next();
    if (req.authLookupError) {
      res.status(503).json({ error: "База документооборота недоступна: " + req.authLookupError.message });
      return;
    }
    if (!req.user) {
      res.status(401).json({ error: "Требуется вход в систему" });
      return;
    }
    if (!permissions.some((permission) => hasPermission(req.user, permission))) {
      res.status(403).json({ error: "Недостаточно прав для этого действия" });
      return;
    }
    next();
  };
}

/** Требует администратора (право управления пользователями). */
export const requireAdmin = requirePermission("users.manage");


/**
 * Кэш проверенных сессий режима клиента: токен → время последней удачной проверки.
 *
 * Живёт в модуле, а не в экземпляре middleware: сессии принадлежат процессу, и после
 * падения удалённого сервера уже подтверждённая сессия должна продолжать работать —
 * почта-то локальная.
 */
const remoteVerified = new Map<string, number>();
/** Сколько держать положительный ответ: иначе каждый запрос к почте ходил бы на сервер. */
const REMOTE_CHECK_TTL_MS = 5000;
const REMOTE_CHECK_TIMEOUT_MS = 3000;
/** Предел кэша: сессий примерно столько, сколько пользователей, но бережёмся. */
const REMOTE_CACHE_MAX = 200;

/** Спрашивает удалённый СЭД, жива ли сессия. «unknown» — сервер не ответил. */
async function checkRemoteSession(baseUrl: string, token: string): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const res = await fetch(baseUrl + "/api/auth/me", {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS)
    });
    if (res.status >= 500) return "unknown";
    if (res.status !== 200) return "invalid";
    const body = (await res.json().catch(() => null)) as { user?: unknown } | null;
    return body && body.user ? "valid" : "invalid";
  } catch {
    return "unknown";
  }
}

function rememberRemoteSession(token: string, at: number): void {
  remoteVerified.delete(token);
  remoteVerified.set(token, at);
  while (remoteVerified.size > REMOTE_CACHE_MAX) {
    const oldest = remoteVerified.keys().next().value;
    if (oldest === undefined) break;
    remoteVerified.delete(oldest);
  }
}

/**
 * Аутентификация локальных маршрутов в режиме клиента (почта локальная, СЭД удалённый).
 *
 * ⚠️ Здесь локальной базы документооборота нет по определению, поэтому requirePermission
 * считает СЭД выключенным и пропускает всех: без этой проверки любой, кто дотянется до порта,
 * читал бы почту и вложения, отправлял письма и забирал ключ модели из /api/ai/config.
 *
 * Сессию подтверждает тот сервер, который её выдал. Если он недоступен: сессию, которую
 * уже подтверждали, пропускаем (локальная почта обязана работать без сервера), незнакомую —
 * нет: иначе достаточно «уронить» сервер, чтобы обойти проверку.
 */
export function requireRemoteSession(options: { baseUrl: string }): express.RequestHandler {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return async (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();
    const token = req.sessionToken;
    if (!token) {
      res.status(401).json({ error: "Требуется вход в систему" });
      return;
    }
    const now = Date.now();
    const verifiedAt = remoteVerified.get(token);
    if (verifiedAt !== undefined && now - verifiedAt < REMOTE_CHECK_TTL_MS) return next();

    const verdict = await checkRemoteSession(baseUrl, token);
    if (verdict === "valid") {
      rememberRemoteSession(token, now);
      return next();
    }
    if (verdict === "invalid") {
      remoteVerified.delete(token);
      res.status(401).json({ error: "Сессия недействительна — войдите заново" });
      return;
    }
    // Сервер недоступен: сессию, подтверждённую раньше, пропускаем — почта локальная.
    if (verifiedAt !== undefined) return next();
    res.status(503).json({ error: "Не удалось проверить сессию: сервер документооборота недоступен" });
  };
}
export function sessionCookieOptions(req: express.Request, maxAgeMs: number) {
  const secure = req.secure || (req.headers["x-forwarded-proto"] ?? "").toString().includes("https");
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeMs
  };
}
