import type { AccountInput } from "@mailsense/core";

/**
 * Умолчания почтового сервера предприятия.
 *
 * Заказчик (пункт 5): почта подключается в основном по POP3/SMTP, и адрес сервера, порты,
 * шифрование и способ входа — ОДНИ И ТЕ ЖЕ для всех. Их задаёт предприятие (в .env или в
 * «Настройки → Почта»), а работник вводит только адрес ящика и пароль.
 *
 * Хранятся настройкой `mail.defaults` (JSON) и засеиваются из `MAILSENSE_MAIL_DEFAULTS` —
 * по тому же правилу, что каталог: значение в базе важнее переменной окружения.
 */
export const MAIL_DEFAULTS_SETTING = "mail.defaults";
export const MAIL_DEFAULTS_ENV = "MAILSENSE_MAIL_DEFAULTS";

/** Что можно задать по умолчанию для одного сервера (входящего или исходящего). */
export interface MailServerDefaults {
  host?: string;
  port?: number;
  tls?: string;
  authType?: string;
}

export interface MailDefaults {
  /** Входящая почта по протоколу ящика: imap или pop3. */
  imap?: MailServerDefaults;
  pop3?: MailServerDefaults;
  /** Отправка. */
  smtp?: MailServerDefaults;
}

const BLOCKS = ["imap", "pop3", "smtp"] as const;

function readServer(raw: unknown): MailServerDefaults | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: MailServerDefaults = {};
  for (const key of ["host", "tls", "authType"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  const port = source.port;
  const portNumber = typeof port === "number" ? port : typeof port === "string" ? Number(port.trim()) : NaN;
  if (Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535) out.port = portNumber;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Разбор умолчаний из JSON (переменная окружения или настройка).
 *
 * ⚠️ Мусор НЕ роняет сервер: возвращаем пустые умолчания и причину — её пишут в журнал.
 * Незнакомые ключи игнорируем: чужая опечатка не должна ломать создание ящика.
 */
export function parseMailDefaults(raw: string | null | undefined): {
  defaults: MailDefaults;
  error: string | null;
} {
  const text = String(raw ?? "").trim();
  if (!text) return { defaults: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { defaults: {}, error: "умолчания почты: не разобрал JSON (" + MAIL_DEFAULTS_ENV + ")" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { defaults: {}, error: "умолчания почты: ожидался объект с ключами imap/pop3/smtp" };
  }
  const source = parsed as Record<string, unknown>;
  const defaults: MailDefaults = {};
  for (const block of BLOCKS) {
    const value = readServer(source[block]);
    if (value) defaults[block] = value;
  }
  return { defaults, error: null };
}

/** Есть ли что применять: пустые умолчания не считаются настроенными. */
/**
 * Строгий разбор того, что прислал АДМИНИСТРАТОР в интерфейсе.
 *
 * ⚠️ В отличие от `.env` (там мусор молча игнорируем, чтобы чужая опечатка не роняла сервер),
 * здесь ошибку надо ПОКАЗАТЬ: админ ждёт ответа и должен видеть, что именно не так.
 */
export function parseMailDefaultsInput(value: unknown): { defaults: MailDefaults; error: string | null } {
  if (value === null || value === undefined) return { defaults: {}, error: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { defaults: {}, error: "Ожидался объект с ключами imap/pop3/smtp" };
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(BLOCKS as readonly string[]).includes(key)) {
      return { defaults: {}, error: "Неизвестный раздел «" + key + "»: допустимы imap, pop3, smtp" };
    }
  }
  const defaults: MailDefaults = {};
  for (const block of BLOCKS) {
    const raw = source[block];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { defaults: {}, error: "Раздел «" + block + "» должен быть объектом с адресом, портом, шифрованием" };
    }
    const server = readServer(raw);
    if (!server) continue;
    const port = (raw as Record<string, unknown>).port;
    if (port !== undefined && port !== null && port !== "" && server.port === undefined) {
      return { defaults: {}, error: "Порт в разделе «" + block + "» должен быть числом от 1 до 65535" };
    }
    const host = (raw as Record<string, unknown>).host;
    if (typeof host === "string" && host.trim() && !server.host) {
      return { defaults: {}, error: "Не разобрал адрес сервера в разделе «" + block + "»" };
    }
    defaults[block] = server;
  }
  return { defaults, error: null };
}

export function hasMailDefaults(defaults: MailDefaults): boolean {
  return BLOCKS.some((block) => !!defaults[block]);
}

/**
 * Дополняет вводимый ящик умолчаниями предприятия.
 *
 * Правило: заполненное человеком НЕ перетираем — умолчание только закрывает пустые поля.
 * Логин и пароли умолчаний не касаются.
 */
export function mergeAccountDefaults(input: AccountInput, defaults: MailDefaults): AccountInput {
  if (!hasMailDefaults(defaults)) return input;
  const incoming = defaults[input.protocol as "imap" | "pop3"] ?? undefined;
  const smtp = defaults.smtp;
  // «Не заполнено» — это пустая строка, ноль/NaN у порта и отсутствие значения. Выбор человека
  // («none» у шифрования, «plain» у входа) пустым НЕ считается: его не перетираем.
  const isEmpty = (value: unknown): boolean =>
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim()) ||
    (typeof value === "number" && !(value > 0));

  const pick = <T>(current: T | null | undefined, fallback: T | undefined): T | null | undefined =>
    isEmpty(current) ? fallback : current;

  return {
    ...input,
    host: (pick(input.host, incoming?.host) ?? input.host) as string,
    port: (pick(input.port, incoming?.port) ?? input.port) as number,
    tls: (pick(input.tls, incoming?.tls) ?? input.tls) as AccountInput["tls"],
    authType: (pick(input.authType, incoming?.authType) ?? input.authType) as AccountInput["authType"],
    smtpHost: pick(input.smtpHost, smtp?.host) ?? input.smtpHost ?? null,
    smtpPort: pick(input.smtpPort, smtp?.port) ?? input.smtpPort ?? null,
    smtpTls: (pick(input.smtpTls, smtp?.tls) ?? input.smtpTls ?? null) as AccountInput["smtpTls"],
    smtpAuthType: (pick(input.smtpAuthType, smtp?.authType) ?? input.smtpAuthType ?? null) as AccountInput["smtpAuthType"]
  };
}
