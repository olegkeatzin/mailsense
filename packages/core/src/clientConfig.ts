/**
 * Откуда клиент берёт адрес сервера СЭД (решение Р21, пункт Т6 плана).
 *
 * Порядок источников:
 *   1) явный аргумент `--server=<url>`;
 *   2) `server.json` РЯДОМ С ИСПОЛНЯЕМЫМ файлом — конфиг предприятия, его кладёт администратор;
 *   3) `server.json` в каталоге пользователя — личная настройка;
 *   4) переменная окружения `MAILSENSE_SERVER_URL`;
 *   5) ничего не задано — автономный (локальный) режим, это НЕ ошибка.
 *
 * ⚠️ Два правила, которые важнее удобства:
 * • **присутствие важнее содержимого**: если файл есть, но испорчен — это честная ошибка,
 *   и дальше искать адрес в следующем источнике НЕЛЬЗЯ. Иначе пользователь молча подключился бы
 *   не к тому серверу, который ему выдали, а админский файл-опечатка выглядел бы как «работает»;
 * • адрес из файла установки — **админский** (managedByAdmin): интерфейс показывает
 *   «Адрес задан администратором» и не даёт пользователю его перезаписать.
 *
 * Функции чистые: ни файловой системы, ни Electron — их зовёт main.ts, а тесты проверяют логику.
 */

/** Источник адреса: аргумент, админский файл, личный файл, переменная окружения. */
export type ServerSource = "arg" | "install" | "user" | "env";

export interface ServerFileParse {
  /** Файла нет вовсе (undefined на входе). */
  present: boolean;
  /** Адрес из файла; null — источник ничего не задаёт (в т.ч. явный null или ""). */
  url: string | null;
  /** Понятная причина, если файл есть, но использовать его нельзя. */
  error: string | null;
}

export interface ServerAddressResolution {
  url: string | null;
  source: ServerSource | null;
  /** Адрес задан администратором (файл рядом с исполняемым) — перезапись запрещена. */
  managedByAdmin: boolean;
  error: string | null;
}

/**
 * Нормализует адрес: обрезает края и хвостовые слэши.
 * Возвращает null, если это не http(s) с непустым хостом.
 */
export function normalizeServerAddress(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null; // «doc.company.local» без схемы — не адрес
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  // ⚠️ new URL("http:///path") считает хостом «path» — то есть пропущенный хост не отвергает.
  // Схему и хост проверяем вручную: между «://» и путём обязан быть непустой authority.
  const authority = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
  if (!authority) return null;
  return value.replace(/\/+$/, "");
}

/**
 * Адрес из переменных окружения.
 *
 * Каноническое имя — `MAILSENSE_SERVER_URL`. Прежнее `MAILSENSE_DOCFLOW_URL` принимаем
 * как запасное: им уже пользуются развёрнутые стенды (и его же читает ядро как
 * MAILSENSE_DOCFLOW_URL), ломать их переименованием нельзя. Пустое каноническое значение
 * не мешает запасному имени.
 */
export function serverAddressFromEnv(env: Record<string, string | undefined> | undefined): string | null {
  const canonical = (env?.MAILSENSE_SERVER_URL ?? "").trim();
  if (canonical) return canonical;
  const legacy = (env?.MAILSENSE_DOCFLOW_URL ?? "").trim();
  return legacy || null;
}

/** Значение аргумента или переменной окружения: пустая строка = «не задано». */
export function parseServerAddress(raw: string | null | undefined): { url: string | null; error: string | null } {
  const value = (raw ?? "").trim();
  if (!value) return { url: null, error: null };
  const url = normalizeServerAddress(value);
  if (!url) {
    return { url: null, error: "адрес должен быть http:// или https:// с непустым хостом, получено «" + value + "»" };
  }
  return { url, error: null };
}

/** Разбирает содержимое server.json (undefined = файла нет). */
export function parseServerConfig(text: string | null | undefined): ServerFileParse {
  if (text === null || text === undefined) return { present: false, url: null, error: null };

  const raw = text.trim();
  // Пустой файл — не «нет файла»: администратор что-то положил и ошибся, об этом надо сказать.
  if (!raw) return { present: true, url: null, error: "файл пуст" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, url: null, error: "не разобрать JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, url: null, error: "ожидается объект вида { \"serverUrl\": \"https://…\" }" };
  }

  // Отсутствие поля — это ошибка конфига, а вот ЯВНЫЙ null/пустая строка — осознанный
  // выбор «локальный режим»: их пишет и сам интерфейс при сбросе адреса.
  if (!Object.prototype.hasOwnProperty.call(parsed, "serverUrl")) {
    return { present: true, url: null, error: "нет поля serverUrl" };
  }
  const value = (parsed as { serverUrl?: unknown }).serverUrl;
  if (value === null || value === undefined) return { present: true, url: null, error: null };
  if (typeof value !== "string") return { present: true, url: null, error: "поле serverUrl должно быть строкой или null" };
  if (!value.trim()) return { present: true, url: null, error: null };

  const url = normalizeServerAddress(value);
  if (!url) {
    return { present: true, url: null, error: "поле serverUrl должно быть http:// или https:// с непустым хостом" };
  }
  return { present: true, url, error: null };
}

/**
 * Выбирает адрес по порядку источников. Любая ошибка возвращается текстом:
 * клиент из-за неё не падает — он поднимается автономно и показывает причину.
 */
export function resolveServerAddress(sources: {
  arg?: string | null;
  installFile?: string | null;
  userFile?: string | null;
  env?: string | null;
}): ServerAddressResolution {
  const argValue = (sources.arg ?? "").trim();
  if (argValue) {
    const r = parseServerAddress(argValue);
    if (r.error) return { url: null, source: "arg", managedByAdmin: false, error: "аргумент --server: " + r.error };
    if (r.url) return { url: r.url, source: "arg", managedByAdmin: false, error: null };
  }

  const install = parseServerConfig(sources.installFile);
  if (install.present) {
    return {
      url: install.error ? null : install.url,
      source: "install",
      managedByAdmin: true,
      error: install.error ? "адрес задан администратором, но файл рядом с программой негоден: " + install.error : null
    };
  }

  const user = parseServerConfig(sources.userFile);
  if (user.present) {
    return {
      url: user.error ? null : user.url,
      source: "user",
      managedByAdmin: false,
      error: user.error ? "личный server.json негоден: " + user.error : null
    };
  }

  const envValue = (sources.env ?? "").trim();
  if (envValue) {
    const r = parseServerAddress(envValue);
    if (r.error) return { url: null, source: "env", managedByAdmin: false, error: "MAILSENSE_SERVER_URL: " + r.error };
    if (r.url) return { url: r.url, source: "env", managedByAdmin: false, error: null };
  }

  return { url: null, source: null, managedByAdmin: false, error: null };
}
