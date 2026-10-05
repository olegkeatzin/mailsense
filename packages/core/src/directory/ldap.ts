import { Client } from "ldapts";
import type { DirectoryContact, LdapProfile, LdapSettings } from "../types.js";

const DEFAULT_ATTRIBUTES = ["displayName", "mail", "sAMAccountName", "cn", "title", "department", "telephoneNumber"];

/** Атрибуты, которые нужны СЭД для профиля сотрудника. */
const PROFILE_ATTRIBUTES = [
  "sAMAccountName",
  "userPrincipalName",
  "mail",
  "cn",
  "displayName",
  "title",
  "department",
  "telephoneNumber",
  "manager",
  "userAccountControl",
  "distinguishedName"
];
const DEFAULT_FILTER =
  "(&(objectCategory=person)(objectClass=user)(mail=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))";

/** Причина отказа аутентификации — чтобы UI показал понятный текст, а не дамп LDAP. */
export type LdapFailure =
  | "invalid_credentials"
  | "password_expired"
  | "account_disabled"
  | "account_locked"
  | "account_expired"
  | "config"
  | "not_found"
  | "network";

export class LdapError extends Error {
  readonly kind: LdapFailure;

  constructor(message: string, kind: LdapFailure) {
    super(message);
    this.name = "LdapError";
    this.kind = kind;
  }
}

/**
 * Разбирает ответ Active Directory. AD не отдаёт человекочитаемую причину:
 * в тексте ошибки есть только «data XXX» и код LDAP.
 *   52e / 525 — неверный логин или пароль
 *   530       — вход запрещён по времени суток
 *   531       — вход запрещён с этого компьютера
 *   532       — срок действия пароля истёк
 *   533       — учётная запись отключена
 *   701       — срок действия учётной записи истёк
 *   773       — требуется смена пароля
 *   775       — учётная запись заблокирована
 */
export function classifyAdError(message: string): LdapFailure {
  if (/data\s+52e|data\s+525/i.test(message)) return "invalid_credentials";
  if (/data\s+532|data\s+773/i.test(message)) return "password_expired";
  if (/data\s+533/i.test(message)) return "account_disabled";
  if (/data\s+701/i.test(message)) return "account_expired";
  if (/data\s+775/i.test(message)) return "account_locked";
  // Обобщённый LDAP-код 49 (0x31) — invalidCredentials.
  if (/invalid credentials|\bdata\s+52e\b|\(49\)|code:\s*0x31/i.test(message)) return "invalid_credentials";
  if (/econnrefused|etimedout|enotfound|socket|connect/i.test(message)) return "network";
  return "invalid_credentials";
}

/** Человекочитаемый текст для причины отказа. */
export function ldapFailureMessage(kind: LdapFailure): string {
  switch (kind) {
    case "invalid_credentials":
      return "Неверный логин или пароль";
    case "password_expired":
      return "Срок действия пароля истёк — смените пароль в домене";
    case "account_disabled":
      return "Учётная запись отключена в каталоге";
    case "account_locked":
      return "Учётная запись заблокирована (превышено число попыток входа)";
    case "account_expired":
      return "Срок действия учётной записи истёк";
    case "config":
      return "Каталог настроен неверно — проверьте URL и Base DN";
    case "not_found":
      return "Учётная запись не найдена в каталоге (проверьте Base DN и фильтр)";
    case "network":
      return "Не удалось подключиться к каталогу — проверьте доступность контроллера домена";
  }
}

/** Собирает строку bind из логина по выбранному формату (UPN/sAM/domain/DN). */
export function buildBindIdentifier(login: string, s: LdapSettings): string {
  const l = (login ?? "").trim();
  if (!l) return l;
  const fmt = s.loginFormat ?? "upn";
  if (fmt === "dn") return l;
  if (fmt === "domain") return (s.netbiosDomain ? s.netbiosDomain + "\\" : "") + l;
  if (fmt === "sam") return l;
  if (l.includes("@")) return l;
  // Суффикс может быть как "@asup.local", так и "asup.local" — не дублируем «@».
  const suffix = s.upnSuffix ?? "";
  return l + (suffix.startsWith("@") || !suffix ? suffix : "@" + suffix);
}

function clientOf(s: LdapSettings): Client {
  return new Client({
    url: s.url && s.url.trim() ? s.url.trim() : "ldap://127.0.0.1:389",
    connectTimeout: 10000,
    timeout: 25000,
    tlsOptions: { rejectUnauthorized: s.rejectUnauthorized === true }
  });
}

/** Проверка логина/пароля простым bind'ом. */
export async function verifyLdapCredentials(s: LdapSettings, login: string, password: string): Promise<void> {
  const c = clientOf(s);
  try {
    await c.bind(buildBindIdentifier(login, s), password);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/** Экранирование значения для LDAP-фильтра (RFC 4515). */
function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => "\\" + ch.charCodeAt(0).toString(16).padStart(2, "0"));
}

function attr(entry: Record<string, unknown>, name: string): string {
  const v = entry[name];
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return v == null ? "" : String(v);
}

function mapEntry(entry: Record<string, unknown>): DirectoryContact {
  return {
    dn: String(entry.dn ?? ""),
    login: attr(entry, "sAMAccountName"),
    displayName: attr(entry, "displayName") || attr(entry, "cn"),
    mail: attr(entry, "mail"),
    title: attr(entry, "title"),
    department: attr(entry, "department"),
    phone: attr(entry, "telephoneNumber")
  };
}

/** Поиск контактов в каталоге от имени пользователя. */
export async function ldapSearchContacts(
  s: LdapSettings,
  login: string,
  password: string,
  query: string,
  limit = 25
): Promise<DirectoryContact[]> {
  const c = clientOf(s);
  try {
    await c.bind(buildBindIdentifier(login, s), password);
    const q = escapeFilter((query ?? "").trim());
    const base = s.userFilter && s.userFilter.trim() ? s.userFilter.trim() : DEFAULT_FILTER;
    const filter = q
      ? "(&" + base + "(|(displayName=*" + q + "*)(mail=*" + q + "*)(sAMAccountName=*" + q + "*)(cn=*" + q + "*)))"
      : base;
    const { searchEntries } = await c.search(s.baseDn ?? "", {
      scope: "sub",
      filter,
      sizeLimit: limit,
      attributes: s.attributes && s.attributes.length ? s.attributes : DEFAULT_ATTRIBUTES
    });
    return searchEntries.map(mapEntry).filter((x) => x.mail || x.displayName);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/**
 * Полная выгрузка сотрудников с атрибутами, нужными СЭД (должность, отдел, руководитель,
 * признак отключённой учётки). Используется синхронизацией справочника пользователей.
 */
export async function ldapListProfiles(
  s: LdapSettings,
  login: string,
  password: string,
  limit = 2000
): Promise<LdapProfile[]> {
  const c = clientOf(s);
  try {
    await c.bind(buildBindIdentifier(login, s), password);
    const base = s.baseDn && s.baseDn.trim() ? s.baseDn.trim() : "";
    if (!base) throw new Error("Не задан Base DN каталога");
    const filter = s.userFilter && s.userFilter.trim() ? s.userFilter.trim() : DEFAULT_FILTER;
    const { searchEntries } = await c.search(base, {
      scope: "sub",
      filter: `(&${filter}(mail=*))`,
      sizeLimit: limit,
      attributes: PROFILE_ATTRIBUTES
    });
    return (searchEntries as unknown as Record<string, unknown>[])
      .map((e) => {
        const uac = Number(attr(e, "userAccountControl") || "0");
        const sam = attr(e, "sAMAccountName");
        return {
          dn: String(e.dn ?? attr(e, "distinguishedName") ?? ""),
          ldapUid: sam,
          email: attr(e, "mail"),
          fullName: attr(e, "displayName") || attr(e, "cn") || sam,
          department: attr(e, "department"),
          position: attr(e, "title"),
          phone: attr(e, "telephoneNumber"),
          managerDn: attr(e, "manager") || null,
          disabled: (uac & 0x2) !== 0
        };
      })
      .filter((p) => p.ldapUid && p.email);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/**
 * Приводит введённый логин к sAMAccountName: пользователь может ввести
 * «user», «user@domain», «DOMAIN\user» или готовый DN.
 */
export function loginToSam(login: string, s: LdapSettings): string {
  const l = (login ?? "").trim();
  if (!l) return l;
  if (s.loginFormat === "dn" || /^(cn|ou|dc)=/i.test(l)) return l; // DN — ищем по DN
  if (l.includes("\\")) return l.slice(l.lastIndexOf("\\") + 1);
  if (l.includes("@")) return l.slice(0, l.indexOf("@"));
  return l;
}

/**
 * Аутентификация в каталоге: bind учёткой пользователя + чтение профиля.
 *
 * Пароль нигде не сохраняется — он живёт только на время bind-запроса.
 * Бросает Error с понятным текстом при неверных данных, отключённой или
 * отсутствующей в каталоге учётной записи.
 */
export async function ldapAuthenticate(s: LdapSettings, login: string, password: string): Promise<LdapProfile> {
  const l = (login ?? "").trim();
  if (!l) throw new Error("Укажите логин");
  if (!password) throw new Error("Укажите пароль");

  const c = clientOf(s);
  try {
    try {
      await c.bind(buildBindIdentifier(l, s), password);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      // Наружу отдаём только классифицированную причину: сырой ответ AD
      // раскрывает внутренние детали каталога и бесполезен пользователю.
      throw new LdapError(msg, classifyAdError(msg));
    }

    const sam = loginToSam(l, s);
    const escaped = escapeFilter(sam);
    const byDn = /^(cn|ou|dc)=/i.test(sam);
    const filter = byDn
      ? `(distinguishedName=${escaped})`
      : `(|(sAMAccountName=${escaped})(userPrincipalName=${escapeFilter(l)})(mail=${escapeFilter(l)}))`;

    const base = s.baseDn && s.baseDn.trim() ? s.baseDn.trim() : "";
    if (!base) throw new LdapError("Не задан Base DN каталога", "config");

    let entries: Record<string, unknown>[];
    try {
      const res = await c.search(base, {
        scope: "sub",
        filter,
        sizeLimit: 2,
        attributes: PROFILE_ATTRIBUTES
      });
      entries = res.searchEntries as unknown as Record<string, unknown>[];
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      // AD отдаёт referrals на соседние разделы, если искать от корня домена.
      if (/referral|operations error/i.test(msg)) {
        throw new LdapError(
          "Каталог вернул ссылку (referral) вместо результата — укажите в Base DN подразделение с пользователями (например OU=KNIITMU,DC=…), а не корень домена",
          "config"
        );
      }
      throw new LdapError(msg, classifyAdError(msg));
    }

    if (!entries.length) {
      throw new LdapError("Учётная запись не найдена в каталоге (проверьте Base DN и фильтр)", "not_found");
    }

    const e = entries[0];
    const uac = Number(attr(e, "userAccountControl") || "0");
    // ACCOUNTDISABLE = 0x0002
    const disabled = (uac & 0x2) !== 0;
    const managerDn = attr(e, "manager") || null;

    return {
      dn: String(e.dn ?? attr(e, "distinguishedName") ?? ""),
      ldapUid: attr(e, "sAMAccountName") || sam,
      email: attr(e, "mail"),
      fullName: attr(e, "displayName") || attr(e, "cn") || sam,
      department: attr(e, "department"),
      position: attr(e, "title"),
      phone: attr(e, "telephoneNumber"),
      managerDn,
      disabled
    };
  } finally {
    await c.unbind().catch(() => undefined);
  }
}
