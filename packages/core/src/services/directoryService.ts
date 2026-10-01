import { getContext } from "../context.js";
import { logger } from "../logger.js";
import { countContacts, getSetting, searchContactsCache, setSetting, upsertContacts } from "../repos.js";
import { ldapSearchContacts, verifyLdapCredentials } from "../directory/ldap.js";
import type { DirectoryContact, LdapSettings } from "../types.js";

const DEFAULT_ATTRIBUTES = ["displayName", "mail", "sAMAccountName", "cn", "title", "department", "telephoneNumber"];

export function getLdapSettings(): LdapSettings {
  const attrs = getSetting("ldap.attributes");
  return {
    enabled: getSetting("ldap.enabled") === "true",
    url: getSetting("ldap.url") ?? "ldaps://srv-dc40.asup.local:636",
    baseDn: getSetting("ldap.baseDn") ?? "DC=asup,DC=local",
    loginFormat: (getSetting("ldap.loginFormat") as LdapSettings["loginFormat"]) ?? "upn",
    upnSuffix: getSetting("ldap.upnSuffix") ?? "@asup.local",
    netbiosDomain: getSetting("ldap.netbiosDomain") ?? "ASUP",
    userFilter: getSetting("ldap.userFilter") ?? "",
    attributes: attrs ? attrs.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ATTRIBUTES,
    sizeLimit: Number(getSetting("ldap.sizeLimit") ?? "25") || 25,
    rejectUnauthorized: getSetting("ldap.rejectUnauthorized") === "true"
  };
}

export function setLdapSettings(patch: Partial<LdapSettings>): LdapSettings {
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
    setSetting("ldap." + k, typeof v === "boolean" ? String(v) : String(v));
  }
  if (patch.attributes !== undefined) setSetting("ldap.attributes", (patch.attributes ?? []).join(","));
  return getLdapSettings();
}

export interface DirectoryStatus {
  loggedIn: boolean;
  login: string | null;
  settings: LdapSettings;
  contacts: number;
}

export function directoryStatus(): DirectoryStatus {
  const login = getSetting("ldap.login") || null;
  const enc = getSetting("ldap.passwordEncrypted");
  return { loggedIn: !!login && !!enc, login, settings: getLdapSettings(), contacts: countContacts() };
}

/** Проверяет логин/пароль bind'ом и запоминает их (пароль — зашифрованно). */
export async function directoryLogin(login: string, password: string): Promise<DirectoryStatus> {
  const s = getLdapSettings();
  if (!s.url || !s.baseDn) throw new Error("Укажите URL и Base DN каталога в настройках");
  await verifyLdapCredentials(s, login, password);
  setSetting("ldap.login", login);
  setSetting("ldap.passwordEncrypted", getContext().secrets.encrypt(password));
  logger.info({ login }, "Вход в каталог выполнен");
  return directoryStatus();
}

export function directoryLogout(): DirectoryStatus {
  setSetting("ldap.login", "");
  setSetting("ldap.passwordEncrypted", "");
  return directoryStatus();
}

function credentials(): { login: string; password: string } | null {
  const login = getSetting("ldap.login");
  const enc = getSetting("ldap.passwordEncrypted");
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
  const cred = credentials();
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

/** Полная выгрузка каталога в кэш. */
export async function refreshDirectory(): Promise<number> {
  const cred = credentials();
  if (!cred) throw new Error("Сначала войдите в каталог");
  const list = await ldapSearchContacts(getLdapSettings(), cred.login, cred.password, "", 2000);
  upsertContacts(list);
  return list.length;
}
