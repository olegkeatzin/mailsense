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
  } catch {
    req.user = null;
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

/** Требует администратора (право управления пользователями). */
export const requireAdmin = requirePermission("users.manage");

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
