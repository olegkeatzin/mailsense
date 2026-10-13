import { Client } from "ldapts";
import { logger } from "../logger.js";
import type { DirectoryContact, LdapProfile, LdapSettings } from "../types.js";

/**
 * Размер страницы при выгрузке всего каталога (LDAP paged results,
 * control 1.2.840.113556.1.4.319). 1000 — это MaxPageSize Active Directory
 * по умолчанию: столько он отдаёт на один непостраничный поиск и на этом
 * молча останавливается.
 */
const LDAP_PAGE_SIZE = 1000;

/**
 * Предел полной выгрузки каталога (профили для СЭД и кэш адресной книги).
 * Это предохранитель от лавины, а не способ обрезать каталог: превышение видно
 * в логе, а для профилей ещё и в признаке truncated. Раньше здесь было 2000 —
 * меньше реального каталога, то есть синхронизация и кэш тихо теряли людей.
 */
export const DIRECTORY_BULK_LIMIT = 20000;

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
  | "strong_auth"
  | "config"
  | "not_found"
  | "network"
  | "unknown";

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
 *   8         — требуется защищённое соединение (простой bind по ldap:// отклонён)
 *
 * ⚠️ Раньше ЛЮБАЯ нераспознанная ошибка объявлялась неверным паролем. На приёмке это стоило
 * времени: администратор видел «Неверный логин или пароль» при заведомо верном пароле, потому
 * что контроллер отвечал кодом, которого классификатор не знал. Теперь неизвестное — это
 * `unknown` с честным текстом и кодом AD в журнале сервера.
 */
export function classifyAdError(message: string): LdapFailure {
  if (/data\s+52e|data\s+525/i.test(message)) return "invalid_credentials";
  if (/data\s+532|data\s+773/i.test(message)) return "password_expired";
  if (/data\s+533/i.test(message)) return "account_disabled";
  if (/data\s+701/i.test(message)) return "account_expired";
  if (/data\s+775/i.test(message)) return "account_locked";
  // Код 8: контроллер требует подписанного/шифрованного соединения.
  // AD отвечает по-разному: «Strong(er) authentication required», «stronger authentication required»,
  // либо кодом: data 8 / (8) / 0x8.
  if (/strong(?:er)?\s*(?:\(er\))?\s*authentication required|confidentiality required|data\s+8\b|\(8\)|code:\s*0x8\b/i.test(message)) {
    return "strong_auth";
  }
  // Обобщённый LDAP-код 49 (0x31) — invalidCredentials.
  if (/invalid credentials|\bdata\s+52e\b|\(49\)|code:\s*0x31/i.test(message)) return "invalid_credentials";
  // Обрыв соединения — тоже недоступность каталога, а не «неизвестная причина»:
  // на развёртывании AD отвечал именно `read ECONNRESET`, и пользователь видел
  // «Неверный логин или пароль» вместо «проверьте доступность контроллера».
  if (/econnrefused|econnreset|econnaborted|epipe|etimedout|enotfound|ehostunreach|enetunreach|socket|connect|network/i.test(message)) {
    return "network";
  }
  return "unknown";
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
    case "strong_auth":
      return "Каталог требует защищённого соединения — включите ldaps:// (порт 636): простой вход по ldap:// контроллер отклонил";
    case "network":
      return "Не удалось подключиться к каталогу — проверьте доступность контроллера домена";
    case "unknown":
      return "Каталог отклонил вход — точная причина (код AD) записана в журнал сервера";
  }
}

/**
 * Похоже ли, что соединение оборвано (а не отказ каталога по учётным данным).
 *
 * Дамп трафика на развёртывании показал: контроллер отвечает на unbind не FIN, а RST, и такое же
 * RST изредка прилетает на первый запрос. Тогда операция падает с ECONNRESET, хотя данные верны.
 */
function isConnectionReset(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /econnreset|econnaborted|epipe|socket hang up/i.test(msg);
}

/**
 * Повторяет операцию ОДИН раз, если соединение оборвалось. Новый вызов создаёт новое соединение
 * (`clientOf`), поэтому повтор имеет смысл. Прочие ошибки не повторяются: отказ по паролю или
 * политике должен дойти до пользователя сразу, без второй попытки.
 */
async function withConnectionRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isConnectionReset(err)) throw err;
    return await run();
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
  await withConnectionRetry(async () => {
    const c = clientOf(s);
    try {
      await c.bind(buildBindIdentifier(login, s), password);
    } finally {
      await c.unbind().catch(() => undefined);
    }
  });
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
  // Тот же повтор при обрыве: поиск в каталоге тоже падал с read ECONNRESET.
  return await withConnectionRetry(() => ldapSearchContactsOnce(s, login, password, query, limit));
}

async function ldapSearchContactsOnce(
  s: LdapSettings,
  login: string,
  password: string,
  query: string,
  limit: number
): Promise<DirectoryContact[]> {
  const c = clientOf(s);
  try {
    await c.bind(buildBindIdentifier(login, s), password);
    const q = escapeFilter((query ?? "").trim());
    const base = s.userFilter && s.userFilter.trim() ? s.userFilter.trim() : DEFAULT_FILTER;
    const filter = q
      ? "(&" + base + "(|(displayName=*" + q + "*)(mail=*" + q + "*)(sAMAccountName=*" + q + "*)(cn=*" + q + "*)))"
      : base;
    // Автодополнение (десятки подсказок) — точечный запрос: страницы ему не нужны
    // и тянули бы весь набор совпадений. А выгрузка каталога в кэш
    // (refreshDirectory → limit 2000) — это полный обход: без paged AD отдаёт
    // только первую страницу, и кэш адресной книги молча остаётся неполным.
    const bulk = limit > LDAP_PAGE_SIZE;
    const { searchEntries } = await c.search(s.baseDn ?? "", {
      scope: "sub",
      filter,
      // Предел серверу отдаём только для точечного запроса: вместе с постраничной
      // выдачей он режет результат по всему поиску (sizeLimitExceeded + часть записей).
      sizeLimit: bulk ? 0 : limit,
      ...(bulk ? { paged: { pageSize: LDAP_PAGE_SIZE } } : {}),
      attributes: s.attributes && s.attributes.length ? s.attributes : DEFAULT_ATTRIBUTES
    });
    const contacts = searchEntries.map(mapEntry).filter((x) => x.mail || x.displayName);
    if (contacts.length > limit) {
      logger.warn(
        { total: contacts.length, limit },
        "Каталог больше предела выгрузки: часть контактов не попала в кэш — увеличьте предел"
      );
      return contacts.slice(0, limit);
    }
    return contacts;
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/**
 * Результат полной выгрузки каталога.
 *
 * ⚠️ Возвращается объект, а не массив, намеренно: вызывающий обязан увидеть,
 * что список может быть неполным. Со массивом старый код молча считал обрезанную
 * выгрузку полным каталогом и деактивировал всех, кого в ней не оказалось.
 */
export interface LdapProfilesResult {
  /** Сотрудники, попавшие в выгрузку (после отбрасывания записей без логина/почты). */
  profiles: LdapProfile[];
  /** Сколько всего нашлось в каталоге — до применения предела. */
  total: number;
  /** true = предел обрезал выгрузку: в profiles НЕ весь каталог, деактивировать нельзя. */
  truncated: boolean;
}

/**
 * Полная выгрузка сотрудников с атрибутами, нужными СЭД (должность, отдел, руководитель,
 * признак отключённой учётки). Используется синхронизацией справочника пользователей.
 *
 * ⚠️ Идёт постранично (paged results). Без этого AD отдаёт не больше MaxPageSize
 * (1000 записей) на один поиск, а вызывающий считает список полным каталогом и
 * деактивирует всех, кого в нём не оказалось: на каталоге больше страницы каждая
 * синхронизация выключала людей и рвала им сессии.
 */
export async function ldapListProfiles(
  s: LdapSettings,
  login: string,
  password: string,
  limit = DIRECTORY_BULK_LIMIT
): Promise<LdapProfilesResult> {
  const c = clientOf(s);
  try {
    await c.bind(buildBindIdentifier(login, s), password);
    const base = s.baseDn && s.baseDn.trim() ? s.baseDn.trim() : "";
    if (!base) throw new Error("Не задан Base DN каталога");
    const filter = s.userFilter && s.userFilter.trim() ? s.userFilter.trim() : DEFAULT_FILTER;
    const { searchEntries } = await c.search(base, {
      scope: "sub",
      filter: `(&${filter}(mail=*))`,
      // ⚠️ Предел серверу НЕ отдаём (0 = без предела). Вместе с постраничной
      // выдачей sizeLimit режет результат по всему поиску: AD вернёт
      // sizeLimitExceeded и часть записей, а вызывающий снова посчитает список
      // полным. Предел держим на клиенте — после обхода всех страниц.
      sizeLimit: 0,
      // Страницами по MaxPageSize AD: ldapts сам продолжает обход по cookie.
      paged: { pageSize: LDAP_PAGE_SIZE },
      attributes: PROFILE_ATTRIBUTES
    });
    const profiles = (searchEntries as unknown as Record<string, unknown>[])
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

    const total = profiles.length;
    // Обрезали — значит, кого-то в синхронизации не увидят. Молчать нельзя:
    // именно молчаливое усечение и приводило к «отключённым» сотрудникам.
    if (total > limit) {
      logger.warn(
        { total, limit },
        "Каталог больше предела выгрузки: часть сотрудников не попала в синхронизацию — увеличьте предел"
      );
      return { profiles: profiles.slice(0, limit), total, truncated: true };
    }
    // Пустой ответ — это почти всегда неверный Base DN или фильтр, а не вымерший
    // домен. Отдельное предупреждение: вызывающий по truncated === false решает,
    // что список полный, и может отключить всех.
    if (total === 0) {
      logger.warn({ base }, "Каталог не вернул ни одного сотрудника — проверьте Base DN и фильтр");
    }
    return { profiles, total, truncated: false };
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

  // Обрыв соединения лечим одной повторной попыткой на НОВОМ соединении: на развёртывании AD
  // отвечает RST в ответ на unbind, и такое же RST изредка прилетает на первый запрос — при этом
  // логин и пароль верны. Повторяем только обрыв, отказ по учётным данным уходит пользователю сразу.
  return await withConnectionRetry(() => ldapAuthenticateOnce(s, l, password));
}

async function ldapAuthenticateOnce(s: LdapSettings, l: string, password: string): Promise<LdapProfile> {
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
