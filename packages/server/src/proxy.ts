import type express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Прокси к серверу документооборота.
 *
 * Клиент держит почту локально, а журнал, пользователей и резолюции — на сервере.
 * Чтобы renderer не знал про два источника и не упирался в CORS, локальный backend
 * просто переадресует «серверные» запросы на удалённый сервер и возвращает ответ как есть.
 * Сессионная cookie при этом остаётся на одном origin (127.0.0.1), поэтому вход работает
 * без SameSite=None и HTTPS.
 */

/**
 * Пути, которые обслуживает сервер документооборота.
 *
 * Каталог (LDAP) тоже здесь: настройки каталога принадлежат предприятию и задаются
 * на сервере. Клиент не хранит их и не ходит в LDAP сам — иначе пользователь мог бы
 * подменить каталог и подсунуть чужие адреса в автодополнение.
 */
const DOCFLOW_PREFIXES = [
  "/api/auth",
  "/api/docflow",
  // Архив года: выгрузка и импорт журнала — серверная работа, в режиме клиента их нет.
  "/api/journal",
  "/api/users",
  "/api/roles",
  "/api/audit",
  "/api/directory",
  "/api/contacts"
];

/**
 * Почтовые пути, которые в режиме клиента тоже обслуживает сервер (task-22, план Т1).
 *
 * Вариант А: почта живёт НА СЕРВЕРЕ — там служебные ящики аппарата (внешний приёмный и
 * внутренний делопроизводственный). Без этих префиксов аппарат видел очередь писем
 * с сервера, но не мог открыть само письмо: оно «локальное», а локальная база пуста.
 *
 * ⚠️ Локально остаются ТОЛЬКО личные вещи работника: `/api/drafts`, `/api/templates`
 * и профиль почты `/api/mail-profile` (его вводит Т2). Список ведётся перечислением, а не
 * «всё остальное»: новый личный путь обязан появиться здесь явно, иначе он молча уедет
 * на сервер, а личные данные работника уезжать не должны.
 */
const MAIL_PREFIXES = [
  // Список и карточка письма, вложения, отправка, смена папки.
  "/api/emails",
  // Ящики предприятия (служебные): их заводит и настраивает администратор.
  "/api/accounts",
  "/api/threads",
  "/api/analysis",
  "/api/import",
  // Шаблон письма строится из серверного ящика (подпись, цитирование) — значит сервер.
  "/api/compose-template",
  // Настройки предприятия целиком: дробить /api/settings решено НЕ (решение Lead'а).
  "/api/settings",
  // Модель, ключ и промпты — настройки предприятия, а не личные.
  "/api/ai"
];

/** Всё, что в режиме клиента уходит на сервер: СЭД + почта. */
const REMOTE_PREFIXES = [...DOCFLOW_PREFIXES, ...MAIL_PREFIXES];

/** Заголовки, которые нельзя переносить в обе стороны. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer"
]);

/** Обслуживает ли путь удалённый сервер (в режиме клиента) — или он локальный. */
export function isProxiedPath(path: string): boolean {
  return REMOTE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

export interface ProxyOptions {
  /** Базовый адрес сервера документооборота, без завершающего слэша. */
  baseUrl: string;
  /** Таймаут запроса, мс. */
  timeoutMs?: number;
}

export function createDocflowProxy(options: ProxyOptions) {
  const { baseUrl, timeoutMs = 30000 } = options;

  return async function docflowProxy(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    if (!isProxiedPath(req.path)) return next();

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const k = key.toLowerCase();
      if (HOP_BY_HOP.has(k)) continue;
      headers.set(k, Array.isArray(value) ? value.join(", ") : String(value));
    }
    // Адрес сервера мог быть задан без схемы — fetch такое не примет.
    headers.set("x-forwarded-host", req.headers.host ?? "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers,
        redirect: "manual",
        signal: controller.signal
      };
      // Тело передаём потоком: вложения бывают крупными, буферизовать их незачем.
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = Readable.toWeb(req) as unknown as ReadableStream;
        init.duplex = "half";
      }

      const upstream = await fetch(baseUrl + req.originalUrl, init);

      res.status(upstream.status);
      for (const [key, value] of upstream.headers) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === "set-cookie") continue;
        res.setHeader(key, value);
      }
      // Set-Cookie перечисляем отдельно: forEach склеивает их в одну строку.
      for (const cookie of upstream.headers.getSetCookie()) res.append("Set-Cookie", cookie);

      if (!upstream.body) {
        res.end();
        return;
      }
      // ⚠️ Именно pipeline, а не pipe: pipe не переносит ошибку источника, и обрыв
      // апстрима посередине ответа становился необработанным исключением — процесс
      // падал вместе с локальной почтой, которая обязана работать и без СЭД.
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } catch (err) {
      const message = (err as Error).name === "AbortError" ? "истёк таймаут" : (err as Error).message;
      // Заголовки уже отправлены — статус не поменять, поэтому обрываем соединение:
      // клиент увидит недополученный ответ, а не «200 с пустым телом».
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Локальная почта обязана работать даже когда сервер недоступен.
      res.status(503).json({ error: "Сервер документооборота недоступен: " + message });
    } finally {
      clearTimeout(timer);
    }
  };
}
