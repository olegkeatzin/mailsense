import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { logger } from "@mailsense/core/directory";
import { getSetting, setSetting } from "./settings.js";
import { getLdapSettings } from "@mailsense/core/directory";
import { LdapError, ldapAuthenticate, ldapFailureMessage } from "@mailsense/core/directory";
import { AppError, AuthError } from "./errors.js";
import { buildAuthUser, permissionsOfRoles } from "./roles.js";
import { hasDocflowDb } from "./db/index.js";
import {
  countUsers,
  deleteSession,
  deleteSessionsForUser,
  getSession,
  getUser,
  getUserByDn,
  getUserByLdapUid,
  getUserPasswordHash,
  getUserRoles,
  grantRole,
  insertSession,
  insertUser,
  listUsersWithRoles,
  purgeExpiredSessions,
  rolesForUsers,
  setUserRoles,
  touchLastLogin,
  touchSession,
  updateUser,
  type DocflowExecutor
} from "./repo.js";
import type { AuthStatus, AuthUser, LoginInput, LoginResult } from "./types.js";
import { writeAudit } from "./audit.js";
import { checkLoginAllowed, noteLoginFailure, noteLoginSuccess } from "./loginThrottle.js";

export const SESSION_COOKIE = "mailsense_sid";

/** Ключи настроек документооборота и аутентификации (таблица settings). */
export const SETTING_DOCFLOW_ENABLED = "docflow.enabled";
export const SETTING_SESSION_TTL = "auth.sessionTtlHours";
export const SETTING_LOCAL_LOGIN = "auth.localLoginEnabled";

const DEFAULT_SESSION_TTL_HOURS = 12;
/** Как часто обновлять last_seen_at: клиент опрашивает API каждые 4 с, писать каждый раз нельзя. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Включён ли документооборот.
 *
 * Если база вообще не поднята (не задан DOCFLOW_DATABASE_URL), считаем функцию
 * выключенной — приложение работает как обычный почтовый клиент. А вот ошибка
 * запроса к уже настроенной базе наружу не глушится: иначе защищённый API
 * молча открылся бы всем.
 */
export async function isDocflowEnabled(): Promise<boolean> {
  if (!hasDocflowDb()) return false;
  return ((await getSetting(SETTING_DOCFLOW_ENABLED)) ?? "false") === "true";
}

export async function setDocflowEnabled(enabled: boolean): Promise<void> {
  await setSetting(SETTING_DOCFLOW_ENABLED, enabled ? "true" : "false");
}

export async function isLocalLoginEnabled(): Promise<boolean> {
  return ((await getSetting(SETTING_LOCAL_LOGIN)) ?? "false") === "true";
}

export async function sessionTtlHours(): Promise<number> {
  const v = Number((await getSetting(SETTING_SESSION_TTL)) ?? String(DEFAULT_SESSION_TTL_HOURS));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SESSION_TTL_HOURS;
}

/** Каталог настраивается в core (общая инфраструктура) — здесь чтение синхронное. */
export function ldapConfigured(): boolean {
  const s = getLdapSettings();
  return !!(s.url && s.url.trim() && s.baseDn && s.baseDn.trim());
}

/**
 * Логины, которым при первом входе выдаётся роль администратора.
 * Задаются вручную через MAILSENSE_ADMIN_LOGINS (через запятую) — автоматически
 * администратором не становится никто: назначение прав это осознанное действие.
 */
export function configuredAdminLogins(): string[] {
  return (process.env.MAILSENSE_ADMIN_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Есть ли в системе хотя бы один действующий администратор. */
export async function hasAdmin(): Promise<boolean> {
  const admins = await listUsersWithRoles({ roleId: "admin", includeInactive: true });
  return admins.some((u) => !u.blocked);
}

export async function authStatus(): Promise<AuthStatus> {
  // Базы нет вовсе — документооборот не настроен. Обращаться к таблицам нельзя,
  // иначе состояние входа отдаёт 500 вместо «функция выключена».
  if (!hasDocflowDb()) {
    return {
      docflowEnabled: false,
      ldapConfigured: ldapConfigured(),
      needsBootstrap: false,
      adminConfigured: configuredAdminLogins().length > 0,
      hasAdmin: false,
      localLoginEnabled: false
    };
  }
  return {
    docflowEnabled: await isDocflowEnabled(),
    ldapConfigured: ldapConfigured(),
    needsBootstrap: (await countUsers()) === 0,
    adminConfigured: configuredAdminLogins().length > 0,
    hasAdmin: await hasAdmin(),
    localLoginEnabled: await isLocalLoginEnabled()
  };
}

// ---------------- Пароли локальных учёток ----------------

/** scrypt: формат scrypt$N$salt$hash (hex). Только для аварийного локального входа. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const N = 16384;
  const hash = scryptSync(plain, salt, 32, { N, r: 8, p: 1 });
  return ["scrypt", N, salt.toString("hex"), hash.toString("hex")].join("$");
}

export function verifyPassword(plain: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (!Number.isFinite(N) || !salt.length || !expected.length) return false;
  const actual = scryptSync(plain, salt, expected.length, { N, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------- Сессии ----------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

async function authUserOf(userId: string): Promise<AuthUser | null> {
  const u = await getUser(userId);
  if (!u) return null;
  return buildAuthUser({ ...u, roles: await getUserRoles(userId) });
}

/** Проверяет токен сессии. Возвращает null, если сессия протухла или пользователь отключён. */
export async function resolveToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const id = hashToken(token);
  const s = await getSession(id);
  if (!s) return null;
  if (Date.parse(s.expiresAt) <= Date.now()) {
    await deleteSession(id);
    return null;
  }
  const user = await authUserOf(s.userId);
  if (!user || !user.isActive || user.blocked) {
    // Уволенный или заблокированный администратором теряет доступ немедленно.
    await deleteSession(id);
    return null;
  }
  if (Date.now() - Date.parse(s.lastSeenAt) > TOUCH_INTERVAL_MS) {
    try {
      await touchSession(id);
    } catch {
      /* не критично */
    }
  }
  return user;
}

export async function logout(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await deleteSession(hashToken(token));
}

/**
 * Разрывает все сессии пользователя (увольнение, смена ролей, отключение).
 *
 * Принимает транзакцию: смена прав и разрыв старых сессий обязаны быть одной
 * операцией — иначе пользователь остался бы с устаревшим набором прав либо
 * потерял сессии без изменения самих прав.
 */
export async function revokeSessions(userId: string, exec?: DocflowExecutor): Promise<number> {
  return deleteSessionsForUser(userId, exec);
}

// ---------------- Вход ----------------

interface LdapProfileInput {
  dn: string;
  ldapUid: string;
  email: string;
  fullName: string;
  department: string;
  position: string;
  phone: string;
  managerDn: string | null;
}

async function upsertLdapUser(profile: LdapProfileInput): Promise<{ id: string; created: boolean }> {
  const existing = await getUserByLdapUid(profile.ldapUid);
  if (existing) {
    await updateUser(existing.id, {
      ldapDn: profile.dn || existing.ldapDn,
      email: profile.email || existing.email,
      fullName: profile.fullName || existing.fullName,
      department: profile.department,
      position: profile.position,
      phone: profile.phone,
      managerDn: profile.managerDn,
      // Кадровые поля обновляем, но ручную блокировку администратора не снимаем.
      isActive: true
    });
    if (existing.blocked) {
      throw new AuthError("Учётная запись заблокирована администратором");
    }
    return { id: existing.id, created: false };
  }
  const u = await insertUser({
    ldapUid: profile.ldapUid,
    ldapDn: profile.dn || null,
    email: profile.email,
    fullName: profile.fullName,
    department: profile.department,
    position: profile.position,
    phone: profile.phone,
    managerDn: profile.managerDn,
    source: "ldap",
    isActive: true
  });
  return { id: u.id, created: true };
}

/** Проставляет managerId по managerDn, если руководитель уже есть в базе. */
export async function linkManager(userId: string, managerDn: string | null): Promise<void> {
  if (!managerDn) return;
  const mgr = await getUserByDn(managerDn);
  if (mgr) await updateUser(userId, { managerId: mgr.id });
}

/**
 * Отказ по учётным данным: попытка считается счётчиком перебора и попадает в аудит.
 *
 * Пароль в аудит не пишется никогда — только логин, адрес и причина отказа.
 * Ошибку записи аудита глушит сам writeAudit: отказ важнее следа.
 */
async function deniedCredentials(
  loginName: string,
  ip: string,
  reason: string,
  message = "Неверный логин или пароль"
): Promise<never> {
  const state = noteLoginFailure(loginName, ip);
  await writeAudit({
    userId: null,
    userName: "",
    action: "login_failed",
    entityType: "user",
    entityId: loginName,
    newValue: { login: loginName, ip, reason, failures: state.failures }
  });
  throw new AuthError(message);
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const loginName = (input.login ?? "").trim();
  if (!loginName) throw new AppError("Укажите логин");
  if (!input.password) throw new AppError("Укажите пароль");
  const ip = (input.ip ?? "").trim();

  // Перебор пароля останавливаем ДО каталога: иначе сам сервер становится
  // инструментом блокировки доменных учёток (политика AD по числу попыток).
  const gate = checkLoginAllowed(loginName, ip);
  if (gate.blocked) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
    await writeAudit({
      userId: null,
      userName: "",
      action: "login_blocked",
      entityType: "user",
      entityId: loginName,
      newValue: { login: loginName, ip, retryAfterMs: gate.retryAfterMs, failures: gate.failures }
    });
    throw new AppError(
      "Слишком много неудачных попыток входа. Повторите через " + minutes + " мин.",
      429,
      "too_many_attempts"
    );
  }

  let userId: string | null = null;

  // 1) Аварийный локальный вход (если включён и такая учётка есть).
  const localUser = await getUserByLdapUid(loginName);
  if ((await isLocalLoginEnabled()) && localUser && localUser.source === "local") {
    if (localUser.blocked) throw new AuthError("Учётная запись заблокирована администратором");
    if (!verifyPassword(input.password, await getUserPasswordHash(localUser.id))) {
      await deniedCredentials(loginName, ip, "invalid_credentials");
    }
    userId = localUser.id;
  } else {
    // 2) Основной путь — LDAP.
    const s = getLdapSettings();
    if (!s.url || !s.url.trim() || !s.baseDn || !s.baseDn.trim()) {
      throw new AppError("Каталог не настроен: заполните «Настройки → Каталог (LDAP)» (URL и Base DN)");
    }

    // Ошибки каталога переводим в понятные отказы: наружу не должен уходить
    // сырой ответ AD (он бесполезен пользователю и раскрывает внутренние детали).
    let profile;
    try {
      profile = await ldapAuthenticate(s, loginName, input.password);
    } catch (err) {
      if (err instanceof LdapError) {
        const text = ldapFailureMessage(err.kind);
        logger.warn({ login: loginName, kind: err.kind }, "Отказ входа в каталоге");
        // Считаем только отказы по учётным данным. Недоступность контроллера домена
        // и «каталог настроен неверно» — не перебор, за них блокировать нельзя.
        if (err.kind === "invalid_credentials" || err.kind === "not_found") {
          await deniedCredentials(loginName, ip, err.kind, text);
        }
        throw new AuthError(text);
      }
      throw err;
    }

    if (profile.disabled) {
      // ТЗ: при отсутствии/блокировке в LDAP вход запрещён, история сохраняется.
      const known = await getUserByLdapUid(profile.ldapUid);
      if (known) {
        await updateUser(known.id, { isActive: false });
        await revokeSessions(known.id);
      }
      throw new AuthError("Учётная запись отключена в каталоге");
    }

    const res = await upsertLdapUser(profile);
    userId = res.id;
    await linkManager(res.id, profile.managerDn);
  }

  if (!userId) throw new AppError("Не удалось определить пользователя");

  // Учётные данные приняты — счётчик неудач по этому логину больше не нужен.
  // (Отказ по блокировке или отсутствию роли ниже — уже не перебор пароля.)
  noteLoginSuccess(loginName, ip);

  // 3) Роль администратора выдаётся только явно перечисленным логинам
  // (MAILSENSE_ADMIN_LOGINS). Автоматического «первый вошедший — админ» нет:
  // права должны назначаться осознанно, а не тем, кто успел войти первым.
  let roles = await getUserRoles(userId);
  const adminLogins = configuredAdminLogins();
  const sam = ((await getUser(userId))?.ldapUid ?? "").trim().toLowerCase();
  if (adminLogins.length && sam && adminLogins.includes(sam) && !roles.includes("admin")) {
    await grantRole(userId, "admin");
    roles = await getUserRoles(userId);
    logger.info({ userId, sam }, "Логину из MAILSENSE_ADMIN_LOGINS выдана роль администратора");
  }

  const user = await authUserOf(userId);
  if (!user) throw new AppError("Не удалось прочитать профиль пользователя");
  if (user.blocked) throw new AuthError("Учётная запись заблокирована администратором");
  if (!user.isActive) throw new AuthError("Учётная запись отключена");

  if (user.roles.length === 0) {
    // Пользователь без роли: вход разрешён, но прав нет — администратор назначит роль.
    logger.info({ userId, login: loginName }, "Вход пользователя без роли");
  }

  const token = newToken();
  const ttlMs = (await sessionTtlHours()) * 60 * 60 * 1000;
  const ts = new Date();
  const expiresAt = new Date(ts.getTime() + ttlMs).toISOString();
  await insertSession({
    id: hashToken(token),
    userId,
    createdAt: ts.toISOString(),
    expiresAt,
    lastSeenAt: ts.toISOString(),
    userAgent: (input.userAgent ?? "").slice(0, 300),
    ip: (input.ip ?? "").slice(0, 60)
  });
  await touchLastLogin(userId);

  await writeAudit({
    userId,
    userName: user.fullName || user.email,
    action: "login",
    entityType: "user",
    entityId: userId,
    newValue: { login: loginName, roles: user.roles }
  });

  return { token, expiresAt, user };
}

/**
 * Создаёт аварийного локального администратора, если заданы переменные окружения
 * MAILSENSE_ADMIN_LOGIN и MAILSENSE_ADMIN_PASSWORD. Нужен на случай недоступности
 * контроллера домена; по умолчанию не создаётся.
 */
export async function seedLocalAdmin(): Promise<boolean> {
  const login = (process.env.MAILSENSE_ADMIN_LOGIN ?? "").trim();
  const password = process.env.MAILSENSE_ADMIN_PASSWORD ?? "";
  if (!login || !password) return false;

  const existing = await getUserByLdapUid(login);
  if (existing) {
    await updateUser(existing.id, { passwordHash: hashPassword(password), source: "local", isActive: true });
    if ((await getUserRoles(existing.id)).length === 0) await grantRole(existing.id, "admin");
    return false;
  }

  const u = await insertUser({
    ldapUid: login,
    email: (process.env.MAILSENSE_ADMIN_EMAIL ?? "").trim(),
    fullName: (process.env.MAILSENSE_ADMIN_NAME ?? "Администратор").trim(),
    source: "local",
    passwordHash: hashPassword(password),
    isActive: true
  });
  await grantRole(u.id, "admin");
  await setSetting(SETTING_LOCAL_LOGIN, "true");
  logger.info({ login }, "Создан аварийный локальный администратор");
  return true;
}

/** Уборка протухших сессий — вызывается при старте и раз в сутки планировщиком. */
export async function cleanupSessions(): Promise<number> {
  try {
    return await purgeExpiredSessions();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Не удалось очистить сессии");
    return 0;
  }
}
