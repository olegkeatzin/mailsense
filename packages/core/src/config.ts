import path from "node:path";
import os from "node:os";

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
      timeoutMs: Number(env("MAILSENSE_AI_TIMEOUT_MS", "120000"))
    },
    defaultAccount,
    seedAccount: env("MAILSENSE_SEED_ACCOUNT", "false") === "true"
  };
}
