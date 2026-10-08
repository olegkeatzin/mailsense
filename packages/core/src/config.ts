import path from "node:path";
import os from "node:os";

/**
 * Сколько страниц PDF рендерить в картинки для OCR по умолчанию (настройка ai.ocrMaxPages).
 *
 * Лимит сделан ЯВНЫМ: одна страница OCR на стенде идёт 4–13 с, документ на сотни страниц
 * иначе займёт минуты. Обрезка НЕ влияет на графу «Кол-во листов» — её считает pdfPageCount
 * по всем страницам — и честно помечается в примечании к вложению, чтобы аппарат видел,
 * что документ прочитан не весь.
 */
export const DEFAULT_OCR_MAX_PAGES = 10;

/**
 * Сколько страниц PDF читать из ТЕКСТОВОГО СЛОЯ по умолчанию (настройка ai.textMaxPages).
 *
 * Отдельный ключ, а не общий с OCR: чтение слоя почти бесплатно (миллисекунды на страницу),
 * поэтому дефолт выше — 20; страница OCR стоит 4–13 с, там дефолт 10. Общий ключ заставлял бы
 * выбирать меньшее из двух и молча терять текст длинного документа.
 */
export const DEFAULT_TEXT_MAX_PAGES = 20;

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** модель поддерживает изображения (vision) */
  multimodal: boolean;
  timeoutMs: number;
  /** отдельная OCR-модель (чтение документов); если не задана — fallback на основную */
  ocrBaseUrl?: string;
  ocrModel?: string;
  /** параллельность запросов к основной (summary) модели */
  concurrency?: number;
  /** параллельность запросов к OCR-модели */
  ocrConcurrency?: number;
  /** максимум страниц PDF, которые рендерятся и распознаются OCR (ai.ocrMaxPages) */
  ocrMaxPages?: number;
  /** максимум страниц PDF, которые читаются из текстового слоя (ai.textMaxPages) */
  textMaxPages?: number;
}

export interface DefaultAccountConfig {
  protocol: "imap" | "pop3";
  host: string;
  port: number;
  tls: "none" | "ssl" | "starttls";
  username: string;
  password: string;
  authType: "login" | "plain" | "oauth2";
}

/**
 * Ящик, заданный переменной окружения MAILSENSE_MAILBOXES: то же, что вводит интерфейс,
 * только без интерфейса — контейнер разворачивается целиком из .env.
 */
export interface MailboxConfig {
  username: string;
  password: string;
  protocol: "imap" | "pop3";
  host: string;
  port: number;
  tls: "none" | "ssl" | "starttls";
  authType: "login" | "plain" | "oauth2";
  smtpHost?: string;
  smtpPort?: number;
  smtpTls?: "none" | "ssl" | "starttls";
  smtpUsername?: string;
  smtpPassword?: string;
}

const TLS_MODES = ["none", "ssl", "starttls"] as const;
const AUTH_TYPES = ["login", "plain", "oauth2"] as const;

/** Поля ящика, которые ядро понимает. Всё остальное — предупреждение о возможной опечатке. */
const KNOWN_MAILBOX_KEYS = new Set([
  "username",
  "password",
  "protocol",
  "host",
  "port",
  "tls",
  "authType",
  "smtpHost",
  "smtpPort",
  "smtpTls",
  "smtpUsername",
  "smtpPassword"
]);

/**
 * tls в переменной задают и булевым (true → ssl, false → none), и строкой режима
 * (для starttls булева мало). Не задано — «ssl»: безопасный дефолт, а не открытый канал.
 */
function readTls(
  raw: unknown,
  title: string,
  where: string,
  errors: string[]
): "none" | "ssl" | "starttls" | null {
  if (raw === undefined || raw === null) return "ssl";
  if (typeof raw === "boolean") return raw ? "ssl" : "none";
  if (typeof raw === "string" && (TLS_MODES as readonly string[]).includes(raw)) {
    return raw as "none" | "ssl" | "starttls";
  }
  errors.push(where + ": " + title + "tls — ожидается true/false или none|ssl|starttls");
  return null;
}

/**
 * Разбирает MAILSENSE_MAILBOXES. Возвращает ящики и понятные причины пропуска:
 * один плохой элемент НЕ роняет остальные и не мешает старту (правило из постановки).
 * Чистая функция — тесты проверяют её без базы и окружения.
 */
export function parseMailboxes(raw: string | null | undefined): {
  mailboxes: MailboxConfig[];
  errors: string[];
  warnings: string[];
} {
  const text = (raw ?? "").trim();
  if (!text) return { mailboxes: [], errors: [], warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { mailboxes: [], errors: ["MAILSENSE_MAILBOXES: не разобрать JSON-массив ящиков"], warnings: [] };
  }
  if (!Array.isArray(parsed)) {
    return { mailboxes: [], errors: ["MAILSENSE_MAILBOXES: ожидается JSON-массив ящиков"], warnings: [] };
  }

  const mailboxes: MailboxConfig[] = [];
  const errors: string[] = [];
  /**
   * Неизвестное поле — предупреждение, а не отказ: ящик рабочий, но опечатка
   * (например smtpPortt) иначе тихо не применилась бы, и причину искали бы в другом месте.
   */
  const warnings: string[] = [];

  parsed.forEach((item, i) => {
    const where = "ящик #" + (i + 1);
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(where + ": ожидается объект с полями ящика");
      return;
    }
    const raw = item as Record<string, unknown>;

    const username = typeof raw.username === "string" ? raw.username.trim() : "";
    if (!username) {
      errors.push(where + ": не указан адрес ящика (username)");
      return;
    }
    const at = where + " (" + username + ")";

    const password = typeof raw.password === "string" ? raw.password : "";
    if (!password) {
      errors.push(at + ": не указан пароль");
      return;
    }
    if (raw.protocol !== "imap" && raw.protocol !== "pop3") {
      errors.push(at + ": неизвестный протокол — ожидается imap или pop3");
      return;
    }
    const host = typeof raw.host === "string" ? raw.host.trim() : "";
    if (!host) {
      errors.push(at + ": не указан сервер (host)");
      return;
    }
    const port = raw.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(at + ": порт должен быть числом 1..65535");
      return;
    }
    const tls = readTls(raw.tls, "", at, errors);
    if (tls === null) return;

    let authType: "login" | "plain" | "oauth2" = "login";
    if (raw.authType !== undefined && raw.authType !== null) {
      if (typeof raw.authType !== "string" || !(AUTH_TYPES as readonly string[]).includes(raw.authType)) {
        errors.push(at + ": способ входа — ожидается login|plain|oauth2");
        return;
      }
      authType = raw.authType as "login" | "plain" | "oauth2";
    }

    const smtpHost = typeof raw.smtpHost === "string" && raw.smtpHost.trim() ? raw.smtpHost.trim() : undefined;
    let smtpPort: number | undefined;
    if (raw.smtpPort !== undefined && raw.smtpPort !== null) {
      const p = raw.smtpPort;
      if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
        errors.push(at + ": порт SMTP должен быть числом 1..65535");
        return;
      }
      smtpPort = p;
    }
    let smtpTls: "none" | "ssl" | "starttls" | undefined;
    if (raw.smtpTls !== undefined && raw.smtpTls !== null) {
      const t = readTls(raw.smtpTls, "SMTP ", at, errors);
      if (t === null) return;
      smtpTls = t;
    }
    const smtpUsername = typeof raw.smtpUsername === "string" && raw.smtpUsername.trim() ? raw.smtpUsername.trim() : undefined;
    const smtpPassword = typeof raw.smtpPassword === "string" && raw.smtpPassword ? raw.smtpPassword : undefined;

    const unknownKeys = Object.keys(raw)
      .filter((key) => !KNOWN_MAILBOX_KEYS.has(key))
      .sort();
    if (unknownKeys.length) {
      warnings.push(at + ": неизвестные поля " + unknownKeys.join(", ") + " — пропущены");
    }

    mailboxes.push({
      username,
      password,
      protocol: raw.protocol,
      host,
      port,
      tls,
      authType,
      ...(smtpHost ? { smtpHost } : {}),
      ...(smtpPort !== undefined ? { smtpPort } : {}),
      ...(smtpTls ? { smtpTls } : {}),
      ...(smtpUsername ? { smtpUsername } : {}),
      ...(smtpPassword ? { smtpPassword } : {})
    });
  });

  return { mailboxes, errors, warnings };
}

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  ai: AiConfig;
  defaultAccount: DefaultAccountConfig | null;
  seedAccount: boolean;
  /** Ящики из MAILSENSE_MAILBOXES (контейнер разворачивается из окружения). */
  mailboxes: MailboxConfig[];
  /** Причины, по которым ящик из переменной пропущен (их логирует засев). */
  mailboxErrors: string[];
  /** Предупреждения по ящикам из переменной: засев их логирует, но ящик создаётся. */
  mailboxWarnings: string[];
  /**
   * Адрес сервера документооборота. Почта при этом остаётся локальной: клиент
   * держит свой ящик и свою базу, а на сервер ходит только за журналом,
   * пользователями и резолюциями. Пусто — документооборот локальный/выключен.
   */
  docflowServerUrl: string | null;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): Config {
  const dataDir =
    process.env.MAILSENSE_DATA_DIR ?? path.join(process.cwd(), "data");

  // Дефолтный аккаунт создаётся только если явно заданы логин и пароль.
  // В сборке нет жёстко зашитых учётных данных.
  const mailUser = process.env.MAILSENSE_MAIL_USER;
  const mailPass = process.env.MAILSENSE_MAIL_PASS;
  const defaultAccount: DefaultAccountConfig | null =
    mailUser && mailPass
      ? {
          protocol: "imap",
          host: env("MAILSENSE_MAIL_HOST", "127.0.0.1"),
          port: Number(env("MAILSENSE_MAIL_PORT", "993")),
          tls: "ssl",
          username: mailUser,
          password: mailPass,
          authType: "login"
        }
      : null;

  const mailboxes = parseMailboxes(env("MAILSENSE_MAILBOXES", ""));

  return {
    dataDir,
    port: Number(env("MAILSENSE_PORT", "8123")),
    host: env("MAILSENSE_HOST", "127.0.0.1"),
    ai: {
      baseUrl: env("MAILSENSE_AI_BASE_URL", "http://localhost:8080/v1"),
      apiKey: env("MAILSENSE_AI_API_KEY", "not-needed"),
      model: env("MAILSENSE_AI_MODEL", ""),
      multimodal: env("MAILSENSE_AI_MULTIMODAL", "true") === "true",
      timeoutMs: Number(env("MAILSENSE_AI_TIMEOUT_MS", "120000")),
      ocrMaxPages: Number(env("MAILSENSE_AI_OCR_MAX_PAGES", String(DEFAULT_OCR_MAX_PAGES))),
      textMaxPages: Number(env("MAILSENSE_AI_TEXT_MAX_PAGES", String(DEFAULT_TEXT_MAX_PAGES))),
      // OCR может жить на ДРУГОМ сервере, чем выжимка: в контейнере интерфейса нет,
      // поэтому источник и модель задаются переменными. Пусто = «не задано» (не пустая строка).
      ocrBaseUrl: env("MAILSENSE_AI_OCR_BASE_URL", "").trim() || undefined,
      ocrModel: env("MAILSENSE_AI_OCR_MODEL", "").trim() || undefined
    },
    defaultAccount,
    seedAccount: env("MAILSENSE_SEED_ACCOUNT", "false") === "true",
    mailboxes: mailboxes.mailboxes,
    mailboxErrors: mailboxes.errors,
    mailboxWarnings: mailboxes.warnings,
    docflowServerUrl: env("MAILSENSE_DOCFLOW_URL", "").trim().replace(/\/+$/, "") || null
  };
}
