import { Client } from "ldapts";
import type { DirectoryContact, LdapSettings } from "../types.js";

const DEFAULT_ATTRIBUTES = ["displayName", "mail", "sAMAccountName", "cn", "title", "department", "telephoneNumber"];
const DEFAULT_FILTER =
  "(&(objectCategory=person)(objectClass=user)(mail=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))";

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
