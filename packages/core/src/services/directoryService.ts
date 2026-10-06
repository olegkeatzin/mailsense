import { getContext } from "../context.js";
import { logger } from "../logger.js";
import { countContacts, getSetting, searchContactsCache, setSetting, upsertContacts } from "../repos.js";
import { DIRECTORY_BULK_LIMIT, ldapSearchContacts, verifyLdapCredentials } from "../directory/ldap.js";
import { ldapSettingsStore } from "./ldapSettingsStore.js";
import type { DirectoryContact, LdapSettings } from "../types.js";

const DEFAULT_ATTRIBUTES = ["displayName", "mail", "sAMAccountName", "cn", "title", "department", "telephoneNumber"];

/**
 * Настройки каталога принадлежат серверной части, если она рядом (см. ldapSettingsStore).
 * Локальная SQLite остаётся запасным хранилищем для автономного почтового клиента.
 */
function ldapGet(key: string): string | null {
  const ext = ldapSettingsStore();
  if (ext) {
    const values = ext.read();
    return values ? (values[key] ?? null) : null;
  }
  return getSetting(key);
}

/**
 * Значение-подсказка для локального режима.
 *
 * Зашитые адреса продакшена имеют смысл только как предзаполнение в автономном
 * почтовом клиенте. Когда владелец настроек — сервер, пустое значит пустое:
 * иначе ненастроенный каталог выглядел бы настроенным и указывал на чужой хост.
 */
function ldapFallback(value: string): string {
  return ldapSettingsStore() ? "" : value;
}

export async function ldapSet(key: string, value: string): Promise<void> {
  const ext = ldapSettingsStore();
  if (ext) {
    await ext.write({ [key]: value });
    return;
  }
  setSetting(key, value);
}
export function getLdapSettings(): LdapSettings {
  const attrs = ldapGet("ldap.attributes");
  return {
    enabled: ldapGet("ldap.enabled") === "true",
    url: ldapGet("ldap.url") ?? ldapFallback("ldaps://srv-dc40.asup.local:636"),
    baseDn: ldapGet("ldap.baseDn") ?? ldapFallback("DC=asup,DC=local"),
    loginFormat: (ldapGet("ldap.loginFormat") as LdapSettings["loginFormat"]) ?? "upn",
    upnSuffix: ldapGet("ldap.upnSuffix") ?? ldapFallback("@asup.local"),
    netbiosDomain: ldapGet("ldap.netbiosDomain") ?? ldapFallback("ASUP"),
    userFilter: ldapGet("ldap.userFilter") ?? "",
    attributes: attrs ? attrs.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ATTRIBUTES,
    sizeLimit: Number(ldapGet("ldap.sizeLimit") ?? "25") || 25,
    rejectUnauthorized: ldapGet("ldap.rejectUnauthorized") === "true"
  };
}

export async function setLdapSettings(patch: Partial<LdapSettings>): Promise<LdapSettings> {
  const scalars: Record<string, unknown> = {
    enabled: patch.enabled,
    url: patch.url,
    baseDn: patch.baseDn,
    loginFormat: patch.loginFormat,
    upnSuffix: patch.upnSuffix,
    netbiosDomain: patch.netbiosDomain,
    userFilter: patch.userFilter,
    sizeLimit: patch.sizeLimit,
    rejectUnauthorized: patch.rejectUnauthorized
  };
  for (const [k, v] of Object.entries(scalars)) {
    if (v === undefined) continue;
    await ldapSet("ldap." + k, typeof v === "boolean" ? String(v) : String(v));
  }
  if (patch.attributes !== undefined) await ldapSet("ldap.attributes", (patch.attributes ?? []).join(","));
  return getLdapSettings();
}

export interface DirectoryStatus {
  loggedIn: boolean;
  login: string | null;
  settings: LdapSettings;
  contacts: number;
}

export function directoryStatus(): DirectoryStatus {
  const login = ldapGet("ldap.login") || null;
  const enc = ldapGet("ldap.passwordEncrypted");
  return { loggedIn: !!login && !!enc, login, settings: getLdapSettings(), contacts: countContacts() };
}

/** Проверяет логин/пароль bind'ом и запоминает их (пароль — зашифрованно). */
export async function directoryLogin(login: string, password: string): Promise<DirectoryStatus> {
  const s = getLdapSettings();
  if (!s.url || !s.baseDn) throw new Error("Укажите URL и Base DN каталога в настройках");
  await verifyLdapCredentials(s, login, password);
  await ldapSet("ldap.login", login);
  await ldapSet("ldap.passwordEncrypted", getContext().secrets.encrypt(password));
  logger.info({ login }, "Вход в каталог выполнен");
  return directoryStatus();
}

export async function directoryLogout(): Promise<DirectoryStatus> {
  await ldapSet("ldap.login", "");
  await ldapSet("ldap.passwordEncrypted", "");
  return directoryStatus();
}

/** Логин/пароль сервисного bind'а каталога (расшифрованный). null — вход не выполнен. */
export function directoryCredentials(): { login: string; password: string } | null {
  const login = ldapGet("ldap.login");
  const enc = ldapGet("ldap.passwordEncrypted");
  if (!login || !enc) return null;
  try {
    return { login, password: getContext().secrets.decrypt(enc) };
  } catch {
    return null;
  }
}

/** Кэш + онлайн-допроверка: моментально отдаём кэш, уточняем из LDAP и обновляем кэш. */
export async function searchDirectory(query: string, limit = 25): Promise<DirectoryContact[]> {
  const cached = searchContactsCache(query, limit);
  const cred = directoryCredentials();
  if (!cred) return cached;
  try {
    const online = await ldapSearchContacts(getLdapSettings(), cred.login, cred.password, query, limit);
    if (online.length) upsertContacts(online);
    const map = new Map<string, DirectoryContact>();
    for (const x of cached) map.set(x.dn, x);
    for (const x of online) map.set(x.dn, x);
    return [...map.values()].slice(0, limit);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Поиск в каталоге не удался — отдаём кэш");
    return cached;
  }
}

/**
 * Полная выгрузка каталога в кэш.
 *
 * ⚠️ Предел здесь — только предохранитель от лавины, а не способ обрезать кэш:
 * с прежними 2000 на большом каталоге в кэш попадала лишь часть сотрудников, и
 * они не находились поиском (а при недоступном LDAP кэш — единственный
 * источник адресной книги). Выгрузка идёт постранично (см. ldapSearchContacts),
 * о превышении предела поиск предупреждает в логе.
 */
export async function refreshDirectory(): Promise<number> {
  const cred = directoryCredentials();
  if (!cred) throw new Error("Сначала войдите в каталог");
  const list = await ldapSearchContacts(getLdapSettings(), cred.login, cred.password, "", DIRECTORY_BULK_LIMIT);
  upsertContacts(list);
  return list.length;
}
