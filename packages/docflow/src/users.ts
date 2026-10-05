import { logger } from "@mailsense/core/directory";
import { getLdapSettings, directoryCredentials } from "@mailsense/core/directory";
import { ldapListProfiles } from "@mailsense/core/directory";
import {
  getRole,
  getUser,
  getUserByDn,
  getUserByLdapUid,
  getUserRoles,
  getUserWithRoles,
  insertUser,
  listRoles,
  listUsersWithRoles,
  setUserRoles,
  updateUser,
  type ListUsersOptions
} from "./repo.js";
import { revokeSessions } from "./auth.js";
import { writeAudit } from "./audit.js";
import { AppError, NotFoundError } from "./errors.js";
import type { AuthUser, User, UserWithRoles } from "./types.js";

export { listUsersWithRoles, getUserWithRoles, listRoles };
export type { ListUsersOptions };

function actorName(actor: AuthUser | null): string {
  return actor ? actor.fullName || actor.email : "система";
}

/** Администраторы, которые реально могут войти (не заблокированы). */
async function countAdmins(): Promise<number> {
  const admins = await listUsersWithRoles({ roleId: "admin", includeInactive: true });
  return admins.filter((u) => !u.blocked).length;
}

/** Назначает пользователю полный набор ролей. Пустой список = снять все роли. */
export async function assignRoles(
  userId: string,
  roleIds: string[],
  actor: AuthUser | null
): Promise<UserWithRoles> {
  const user = await getUser(userId);
  if (!user) throw new NotFoundError("Пользователь не найден");

  const unknown: string[] = [];
  for (const r of roleIds) {
    if (!(await getRole(r))) unknown.push(r);
  }
  if (unknown.length) throw new AppError("Неизвестные роли: " + unknown.join(", "));

  // Нельзя оставить систему без администратора — иначе некому будет выдать права.
  const before = await getUserRoles(userId);
  const wasAdmin = before.includes("admin") && !user.blocked;
  const willBeAdmin = roleIds.includes("admin");
  if (wasAdmin && !willBeAdmin && (await countAdmins()) === 1) {
    throw new AppError("В системе должен остаться хотя бы один администратор");
  }

  const after = await setUserRoles(userId, roleIds, actor?.id ?? null);
  // Права изменились — старые сессии несут устаревший набор прав.
  await revokeSessions(userId);

  await writeAudit({
    userId: actor?.id ?? null,
    userName: actorName(actor),
    action: "user.roles",
    entityType: "user",
    entityId: userId,
    oldValue: { roles: before },
    newValue: { roles: after }
  });

  return { ...user, roles: after };
}

/**
 * Блокирует/разблокирует учётную запись.
 *
 * Это именно ручная блокировка (`blocked`), а не следование за каталогом: увольнение
 * приходит из AD в `is_active`, и синхронизация справочника ручную блокировку не снимает.
 * Блокировка немедленно рвёт сессии.
 */
export async function setUserActive(userId: string, isActive: boolean, actor: AuthUser | null): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new NotFoundError("Пользователь не найден");

  const blocked = !isActive;
  if (blocked && user.id === actor?.id) {
    throw new AppError("Нельзя заблокировать собственную учётную запись");
  }
  if (blocked && (await getUserRoles(userId)).includes("admin") && (await countAdmins()) === 1) {
    throw new AppError("В системе должен остаться хотя бы один администратор");
  }

  const updated = await updateUser(userId, { blocked });
  if (blocked) await revokeSessions(userId);

  await writeAudit({
    userId: actor?.id ?? null,
    userName: actorName(actor),
    action: blocked ? "user.block" : "user.unblock",
    entityType: "user",
    entityId: userId,
    oldValue: { blocked: user.blocked },
    newValue: { blocked }
  });

  return updated!;
}

export interface ManualUserInput {
  email: string;
  fullName?: string;
  department?: string;
  position?: string;
  phone?: string;
  roleIds?: string[];
}

/**
 * Ручное создание учётки — внешние контрагенты и сотрудники, которых нет в каталоге
 * (ТЗ п. 6: «ручное создание внешних контрагентов»). Войти в систему такая учётка
 * не может: пароля у неё нет, source = manual.
 */
export async function createManualUser(input: ManualUserInput, actor: AuthUser | null): Promise<UserWithRoles> {
  const email = (input.email ?? "").trim();
  if (!email) throw new AppError("Укажите email");
  const all = await listUsersWithRoles({ includeInactive: true });
  if (all.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    throw new AppError("Пользователь с таким email уже есть");
  }

  const u = await insertUser({
    email,
    fullName: (input.fullName ?? "").trim() || email,
    department: (input.department ?? "").trim(),
    position: (input.position ?? "").trim(),
    phone: (input.phone ?? "").trim(),
    source: "manual",
    isActive: true,
    passwordHash: null
  });

  const roles: string[] = [];
  for (const r of input.roleIds ?? []) {
    if (await getRole(r)) roles.push(r);
  }
  if (roles.length) await setUserRoles(u.id, roles, actor?.id ?? null);

  await writeAudit({
    userId: actor?.id ?? null,
    userName: actorName(actor),
    action: "user.create",
    entityType: "user",
    entityId: u.id,
    newValue: { email, fullName: u.fullName, roles }
  });

  return { ...u, roles };
}

export async function updateManualUser(
  userId: string,
  patch: { fullName?: string; department?: string; position?: string; phone?: string; email?: string },
  actor: AuthUser | null
): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new NotFoundError("Пользователь не найден");
  const before = { ...user };
  const updated = (await updateUser(userId, patch))!;
  await writeAudit({
    userId: actor?.id ?? null,
    userName: actorName(actor),
    action: "user.update",
    entityType: "user",
    entityId: userId,
    oldValue: {
      fullName: before.fullName,
      department: before.department,
      position: before.position,
      phone: before.phone,
      email: before.email
    },
    newValue: patch
  });
  return updated;
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  linked: number;
}

/**
 * Синхронизация справочника сотрудников из LDAP.
 * LDAP — источник истины для кадровых данных: ФИО, email, отдел, должность, руководитель.
 * Роли не трогаем — они живут в базе документооборота (ТЗ п. 2).
 * Сотрудники, исчезнувшие из каталога, помечаются is_active = false (история сохраняется).
 */
export async function syncDirectoryUsers(actor: AuthUser | null): Promise<SyncResult> {
  const cred = directoryCredentials();
  if (!cred) throw new AppError("Сначала войдите в каталог: «Настройки → Каталог (LDAP)»");

  const s = getLdapSettings();
  const profiles = await ldapListProfiles(s, cred.login, cred.password, 5000);

  const result: SyncResult = { total: profiles.length, created: 0, updated: 0, deactivated: 0, linked: 0 };
  const seen = new Set<string>();

  for (const p of profiles) {
    seen.add(p.ldapUid.toLowerCase());
    const existing = await getUserByLdapUid(p.ldapUid);
    if (existing) {
      await updateUser(existing.id, {
        ldapDn: p.dn || existing.ldapDn,
        email: p.email || existing.email,
        fullName: p.fullName || existing.fullName,
        department: p.department,
        position: p.position,
        phone: p.phone,
        managerDn: p.managerDn,
        // is_active следует за каталогом; ручную блокировку (blocked) синхронизация не трогает.
        isActive: !p.disabled
      });
      result.updated++;
    } else {
      await insertUser({
        ldapUid: p.ldapUid,
        ldapDn: p.dn || null,
        email: p.email,
        fullName: p.fullName,
        department: p.department,
        position: p.position,
        phone: p.phone,
        managerDn: p.managerDn,
        source: "ldap",
        isActive: !p.disabled
      });
      result.created++;
    }
  }

  // Ушли из каталога — блокируем вход, но историю сохраняем (ТЗ п. 2 «Увольнение»).
  for (const u of await listUsersWithRoles({ includeInactive: false })) {
    if (u.source !== "ldap" || !u.ldapUid) continue;
    if (seen.has(u.ldapUid.toLowerCase())) continue;
    await updateUser(u.id, { isActive: false });
    await revokeSessions(u.id);
    result.deactivated++;
  }

  // Связываем «руководитель → подчинённый» по DN.
  for (const u of await listUsersWithRoles({ includeInactive: true })) {
    if (!u.managerDn) continue;
    const mgr = await getUserByDn(u.managerDn);
    if (mgr && mgr.id !== u.managerId) {
      await updateUser(u.id, { managerId: mgr.id });
      result.linked++;
    }
  }

  await writeAudit({
    userId: actor?.id ?? null,
    userName: actorName(actor),
    action: "directory.sync",
    entityType: "user",
    newValue: result
  });

  logger.info(result, "Синхронизация справочника сотрудников выполнена");
  return result;
}
