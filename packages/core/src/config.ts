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

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  ai: AiConfig;
  defaultAccount: DefaultAccountConfig | null;
  seedAccount: boolean;
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
    docflowServerUrl: env("MAILSENSE_DOCFLOW_URL", "").trim().replace(/\/+$/, "") || null
  };
}
