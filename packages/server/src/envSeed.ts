import { getAccountByUsername, getContext, type Account } from "@mailsense/core";
import {
  MAIL_DEFAULTS_ENV,
  MAIL_DEFAULTS_SETTING,
  hasMailDefaults,
  parseMailDefaults
} from "./mailDefaults.js";
import {
  EXTERNAL_ACCOUNT_SETTING,
  SERVICE_ACCOUNT_SETTING,
  getSetting,
  setServiceAccounts,
  setSetting,
  type Actor
} from "@mailsense/docflow";

/**
 * Засев каталога и служебных ящиков из окружения (T51).
 *
 * Заказчик разворачивает контейнер целиком из .env: адрес каталога, учётка bind'а и адреса
 * служебных ящиков задаются переменными. Правило одно и то же для всего:
 *
 *   ⚠️ ПЕРЕМЕННАЯ ОКРУЖЕНИЯ ГЛАВНЕЕ БАЗЫ. Значение из .env применяется при КАЖДОМ старте и
 *   перекрывает то, что сохранено в интерфейсе: развёртывание описано файлом, и перезапуск не
 *   должен оставлять «старый» адрес. Пустая переменная = «не задано»: пустотой ничего не стираем.
 *   Каждая замена пишется в журнал — чтобы смена значения не была неожиданной.
 *
 * ⚠️ Ошибки засева НЕ роняют старт: всё в журнал одной понятной строкой и без паролей —
 * сервер обязан подниматься, даже если каталог недоступен или адрес ящика указан с опечаткой.
 */

/** Системный автор изменений: настройки поставило развёртывание, а не человек в интерфейсе. */
const SYSTEM_ACTOR: Actor = { id: null, name: "Настройки окружения" };

export interface LdapSeedResult {
  written: string[];
  skipped: string[];
  warnings: string[];
}

/** Что читаем из окружения: имя переменной → ключ настройки каталога. */
const LDAP_ENV_KEYS: Array<[string, string, string]> = [
  ["MAILSENSE_LDAP_ENABLED", "ldap.enabled", "Включён"],
  ["MAILSENSE_LDAP_URL", "ldap.url", "Адрес"],
  ["MAILSENSE_LDAP_BASE_DN", "ldap.baseDn", "Base DN"],
  ["MAILSENSE_LDAP_LOGIN_FORMAT", "ldap.loginFormat", "Формат логина"],
  ["MAILSENSE_LDAP_UPN_SUFFIX", "ldap.upnSuffix", "Суффикс UPN"],
  ["MAILSENSE_LDAP_REJECT_UNAUTHORIZED", "ldap.rejectUnauthorized", "Проверка сертификата"]
];

export interface LdapSeedDeps {
  env: NodeJS.ProcessEnv;
  /** Есть ли уже значение в базе (null — настройки нет). */
  readSetting: (key: string) => Promise<string | null>;
  writeSetting: (key: string, value: string) => Promise<void>;
  /** Шифрование пароля каталога — тем же механизмом, что интерфейс. */
  encrypt: (plain: string) => string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = (env[name] ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * Записывает настройки каталога из переменных, НЕ трогая то, что уже задано в базе.
 *
 * Пароль каталога шифруется тем же механизмом, что интерфейс (ldap.passwordEncrypted):
 * в открытом виде он не попадает ни в базу, ни в журнал.
 */
export async function seedLdapFromEnv(deps: LdapSeedDeps): Promise<LdapSeedResult> {
  const result: LdapSeedResult = { written: [], skipped: [], warnings: [] };
  const { env } = deps;

  const ldapLogin = envValue(env, "MAILSENSE_LDAP_LOGIN");
  const ldapPassword = envValue(env, "MAILSENSE_LDAP_PASSWORD");
  const anyEnv =
    LDAP_ENV_KEYS.some(([name]) => envValue(env, name) !== null) || ldapLogin !== null || ldapPassword !== null;
  if (!anyEnv) return result;

  for (const [name, key, label] of LDAP_ENV_KEYS) {
    const value = envValue(env, name);
    if (value === null) continue;
    const current = await deps.readSetting(key);
    if (current !== null && current.trim() === value) {
      // Уже то же самое: писать нечего, но и «пропущено» тут значит «совпадает».
      result.skipped.push(label);
      continue;
    }
    await deps.writeSetting(key, value);
    result.written.push(label);
  }

  // Учётка bind'а: логин и пароль — пара. Одного без другого недостаточно для входа.
  if (ldapLogin !== null || ldapPassword !== null) {
    if (ldapLogin === null || ldapPassword === null) {
      result.warnings.push("учётка каталога задана неполно: нужны и логин, и пароль");
    } else {
      // Пароль хранится зашифрованным, сравнить его с переменной нельзя — поэтому учётку
      // из .env применяем всегда (шифруем заново). Логин в переменной задан явно, значит
      // это и есть желаемое состояние развёртывания.
      const currentLogin = await deps.readSetting("ldap.login");
      const currentPassword = await deps.readSetting("ldap.passwordEncrypted");
      const sameLogin = (currentLogin ?? "").trim() === ldapLogin;
      if (sameLogin && currentPassword) {
        result.skipped.push("Учётка каталога");
      } else {
        await deps.writeSetting("ldap.login", ldapLogin);
        await deps.writeSetting("ldap.passwordEncrypted", deps.encrypt(ldapPassword));
        result.written.push("Учётка каталога");
      }
    }
  }

  // Каталогу нужны адрес и Base DN: без них он не работает, но старт ронять нельзя.
  const url = envValue(env, "MAILSENSE_LDAP_URL") ?? (await deps.readSetting("ldap.url"));
  const baseDn = envValue(env, "MAILSENSE_LDAP_BASE_DN") ?? (await deps.readSetting("ldap.baseDn"));
  if (!url || !baseDn) {
    result.warnings.push("каталог настроен неполно: нужны MAILSENSE_LDAP_URL и MAILSENSE_LDAP_BASE_DN");
  }
  return result;
}

export interface MailboxSeedResult {
  internal?: "written" | "skipped" | "not_found" | "not_set";
  external?: "written" | "skipped" | "not_found" | "not_set";
  warnings: string[];
}

export interface MailDefaultsSeedResult {
  written: boolean;
  skipped: boolean;
  warnings: string[];
}

/**
 * Умолчания почтового сервера из окружения (пункт 5 заказчика).
 *
 * Работник тогда вводит только адрес ящика и пароль: хост, порты, шифрование и способ входа
 * приходят из `MAILSENSE_MAIL_DEFAULTS` (JSON с ключами imap/pop3/smtp).
 * ⚠️ Правило то же, что у каталога: переменная окружения главнее базы.
 */
export async function seedMailDefaultsFromEnv(deps: {
  env: NodeJS.ProcessEnv;
  readSetting: (key: string) => Promise<string | null>;
  writeSetting: (key: string, value: string) => Promise<void>;
}): Promise<MailDefaultsSeedResult | null> {
  const raw = envValue(deps.env, MAIL_DEFAULTS_ENV);
  if (raw === null) return null;

  const result: MailDefaultsSeedResult = { written: false, skipped: false, warnings: [] };
  const parsed = parseMailDefaults(raw);
  if (parsed.error) {
    result.warnings.push(parsed.error);
    return result;
  }
  if (!hasMailDefaults(parsed.defaults)) {
    result.warnings.push("умолчания почты пусты: записывать нечего");
    return result;
  }
  const value = JSON.stringify(parsed.defaults);
  const current = await deps.readSetting(MAIL_DEFAULTS_SETTING);
  if (current !== null && current.trim() === value) {
    // Уже такие же — писать нечего.
    result.skipped = true;
    return result;
  }
  // ⚠️ Переменная главнее базы: значение из .env применяется при каждом старте.
  await deps.writeSetting(MAIL_DEFAULTS_SETTING, value);
  result.written = true;
  return result;
}

export interface MailboxSeedDeps {
  env: NodeJS.ProcessEnv;
  readSetting: (key: string) => Promise<string | null>;
  /**
   * Поиск ящика по адресу. В ядре это getAccountByUsername: сравнение в JS
   * (регистр и краевые пробелы не важны) — SQLite lower() работает только по ASCII.
   */
  findAccount: (address: string) => Account | null;
  writeServiceAccounts: (input: { internal?: string | null; external?: string | null }) => Promise<unknown>;
}

/**
 * Записывает роли служебных ящиков по адресам из окружения.
 *
 * Вызывать ПОСЛЕ засева ящиков ядром (T50) — иначе ящика ещё нет и найти его нечем.
 * Роль из переменной перекрывает прежнюю; ненайденный адрес — строка в журнал, а не падение.
 */
export async function seedServiceMailboxesFromEnv(deps: MailboxSeedDeps): Promise<MailboxSeedResult> {
  const result: MailboxSeedResult = { warnings: [] };
  const internal = envValue(deps.env, "MAILSENSE_SERVICE_MAILBOX");
  const external = envValue(deps.env, "MAILSENSE_EXTERNAL_MAILBOX");
  if (internal === null) result.internal = "not_set";
  if (external === null) result.external = "not_set";
  if (internal === null && external === null) return result;

  const patch: { internal?: string; external?: string } = {};

  const resolve = async (
    role: "internal" | "external",
    address: string | null,
    key: string
  ): Promise<void> => {
    if (address === null) return;
    const account = deps.findAccount(address);
    if (!account) {
      result[role] = "not_found";
      result.warnings.push("ящик " + address + " не найден среди засеянных");
      return;
    }
    // ⚠️ Переменная главнее базы: если в .env другой ящик — роль переставляем.
    const current = await deps.readSetting(key);
    if (current !== null && current.trim() === account.id) {
      result[role] = "skipped";
      return;
    }
    patch[role] = account.id;
    result[role] = "written";
  };

  await resolve("internal", internal, SERVICE_ACCOUNT_SETTING);
  await resolve("external", external, EXTERNAL_ACCOUNT_SETTING);

  if (patch.internal || patch.external) {
    await deps.writeServiceAccounts(patch);
  }

  // Пилот допускает один ящик на обе роли: это не запрет, но администратору стоит знать.
  // Смотрим ИТОГОВЫЕ значения: только что записанные или уже лежащие в базе.
  const internalId = patch.internal ?? (await deps.readSetting(SERVICE_ACCOUNT_SETTING));
  const externalId = patch.external ?? (await deps.readSetting(EXTERNAL_ACCOUNT_SETTING));
  if (internalId && externalId && internalId === externalId) {
    result.warnings.push("внешняя и внутренняя роли указывают на один ящик (пилот)");
  }
  return result;
}

/** Итог засева одной строкой в журнал: что настроено, что пропущено, что не удалось. */
export interface MailboxSeedReport {
  created: number;
  skipped: number;
  failed: number;
}

export function describeSeedSummary(
  ldap: LdapSeedResult | null,
  mailboxes: MailboxSeedResult | null,
  mailboxSeed?: MailboxSeedReport | null,
  mailDefaults?: MailDefaultsSeedResult | null
): string {
  const parts: string[] = [];
  if (mailDefaults) {
    parts.push(
      "умолчания почты: " +
        (mailDefaults.written ? "применены из .env" : mailDefaults.skipped ? "уже такие же" : "не записаны")
    );
    for (const w of mailDefaults.warnings) parts.push("умолчания почты: " + w);
  }
  if (mailboxSeed) {
    parts.push(
      "ящики ядра: создано " + mailboxSeed.created + ", пропущено " + mailboxSeed.skipped + ", ошибок " + mailboxSeed.failed
    );
  }
  if (ldap) {
    parts.push(
      "каталог: применено из .env " + ldap.written.length + ", без изменений " + ldap.skipped.length
    );
    for (const w of ldap.warnings) parts.push("каталог: " + w);
  }
  if (mailboxes) {
    const role = (v?: string): string => (v === "written" ? "применён из .env" : v === "skipped" ? "уже тот же" : v === "not_found" ? "НЕ НАЙДЕН" : "не задан");
    parts.push("ящики: внутренний " + role(mailboxes.internal) + ", внешний " + role(mailboxes.external));
    for (const w of mailboxes.warnings) parts.push("ящики: " + w);
  }
  return "Засев из окружения — " + parts.join("; ");
}

export interface EnvSeedDeps {
  env: NodeJS.ProcessEnv;
  readSetting?: (key: string) => Promise<string | null>;
  writeSetting?: (key: string, value: string) => Promise<void>;
  encrypt?: (plain: string) => string;
  findAccount?: (address: string) => Account | null;
  writeServiceAccounts?: (input: { internal?: string | null; external?: string | null }) => Promise<unknown>;
  /** Сводка засева ящиков ядром (initApp) — попадает в общую строку журнала. */
  mailboxSeed?: MailboxSeedReport | null;
}

export interface EnvSeedOutcome {
  ldap: LdapSeedResult | null;
  mailboxes: MailboxSeedResult | null;
  mailDefaults: MailDefaultsSeedResult | null;
  /** Одна строка для журнала: что настроено, что пропущено, что не удалось. */
  summary: string;
  /** Сбой засева не роняет старт: причина попадает сюда и в журнал. */
  error?: string;
}

/**
 * Засев из окружения целиком. НИКОГДА не бросает: любая ошибка (нет базы, не расшифровался
 * пароль, сбой записи) превращается в строку журнала, а сервер продолжает подниматься.
 */
export async function seedFromEnvironment(deps: EnvSeedDeps): Promise<EnvSeedOutcome> {
  const readSetting = deps.readSetting ?? getSetting;
  const writeSetting = deps.writeSetting ?? setSetting;
  const findAccountFn = deps.findAccount ?? getAccountByUsername;
  const writeServiceAccounts =
    deps.writeServiceAccounts ?? ((input) => setServiceAccounts(input, SYSTEM_ACTOR));
  const encrypt = deps.encrypt ?? ((plain: string) => getContext().secrets.encrypt(plain));

  let ldap: LdapSeedResult | null = null;
  let mailboxes: MailboxSeedResult | null = null;
  let mailDefaults: MailDefaultsSeedResult | null = null;
  const problems: string[] = [];

  try {
    ldap = await seedLdapFromEnv({ env: deps.env, readSetting, writeSetting, encrypt });
  } catch (err) {
    ldap = null;
    problems.push("каталог: " + (err as Error).message);
  }
  try {
    mailDefaults = await seedMailDefaultsFromEnv({ env: deps.env, readSetting, writeSetting });
  } catch (err) {
    mailDefaults = null;
    problems.push("умолчания почты: " + (err as Error).message);
  }
  try {
    mailboxes = await seedServiceMailboxesFromEnv({
      env: deps.env,
      readSetting,
      findAccount: findAccountFn,
      writeServiceAccounts
    });
  } catch (err) {
    mailboxes = null;
    problems.push("ящики: " + (err as Error).message);
  }

  const summary =
    describeSeedSummary(ldap, mailboxes, deps.mailboxSeed, mailDefaults) +
    (problems.length ? "; НЕ УДАЛОСЬ — " + problems.join("; ") : "");
  return {
    ldap,
    mailboxes,
    mailDefaults,
    summary,
    ...(problems.length ? { error: problems.join("; ") } : {})
  };
}
