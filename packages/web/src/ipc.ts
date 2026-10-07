/**
 * Мост в Electron: настройка адреса сервера документооборота (режим тонкого клиента).
 *
 * В браузере моста нет — это нормальный режим, а не ошибка: там адрес задаётся сервером,
 * который отдал страницу. Поэтому доступ к мосту всегда через serverBridge(): он вернёт null,
 * если приложение открыто не в Electron, и интерфейс честно скажет об этом.
 */
export type ServerConfigSource = "arg" | "install" | "user" | "env" | null;

export interface ServerConfig {
  serverUrl: string | null;
  source: ServerConfigSource;
  /** Адрес задал администратор файлом рядом с программой: переписывать его нельзя. */
  managedByAdmin: boolean;
  /** Ошибка разбора файла конфигурации; при ней приложение работает автономно. */
  error: string | null;
  /** Адрес локального сервера, если он поднят (для справки). */
  localServerUrl: string | null;
}

export interface ServerConfigWriteResult {
  ok: boolean;
  serverUrl?: string | null;
  managedByAdmin?: boolean;
  error?: string;
}

export interface MailsenseBridge {
  isElectron?: boolean;
  getServerConfig: () => Promise<ServerConfig>;
  setServerUrl: (url: string) => Promise<ServerConfigWriteResult>;
  clearServerUrl: () => Promise<ServerConfigWriteResult>;
  relaunch?: () => Promise<void>;
}

declare global {
  interface Window {
    mailsense?: MailsenseBridge;
  }
}

/** Мост в Electron или null, если мы в обычном браузере. */
export function serverBridge(): MailsenseBridge | null {
  if (typeof window === "undefined") return null;
  return window.mailsense ?? null;
}

/** Человеческий текст источника адреса — без технических слов. */
export function serverSourceTitle(source: ServerConfigSource): string {
  switch (source) {
    case "arg":
      return "задан параметром запуска";
    case "install":
      return "задан администратором (файл рядом с программой)";
    case "user":
      return "задан в личных настройках";
    case "env":
      return "задан переменной окружения";
    default:
      return "не задан — автономный режим";
  }
}
