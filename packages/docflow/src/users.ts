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
  insertAudit,
  insertUser,
  listRoles,
  listUsersWithRoles,
  setUserRoles,
  updateUser,
  type ListUsersOptions
} from "./repo.js";
import { revokeSessions } from "./auth.js";
import { getDocflowDb } from "./db/index.js";
import { AppError, NotFoundError } from "./errors.js";
import type { AuthUser, User, UserWithRoles } from "./types.js";

export { listUsersWithRoles, getUserWithRoles, listRoles };
export type { ListUsersOptions };

function actorName(actor: AuthUser | null): string {
  return actor ? actor.fullName || actor.email : "система";
}

/**
 * Администраторы, которые реально могут войти (не заблокированы).
 *
 * ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (не баг этой правки, разбирается отдельной задачей):
 * проверки «останется хотя бы один администратор» читают это число ВНЕ транзакции
 * изменения. Два одновременных снятия прав у двух последних администраторов могут
 * оба увидеть «администраторов двое» и пройти — система останется без администратора.
 * Лечится блокировкой строк администраторов (или advisory-локом) внутри транзакции;
 * сознательно не сделано сейчас, чтобы не менять правила выдачи прав без решения.
 */
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
  // ⚠️ Проверка идёт вне транзакции (гонку см. в комментарии к countAdmins): здесь
  // она только отсекает очевидный случай «снимаю права у единственного».
  const before = await getUserRoles(userId);
  const wasAdmin = before.includes("admin") && !user.blocked;
  const willBeAdmin = roleIds.includes("admin");
  if (wasAdmin && !willBeAdmin && (await countAdmins()) === 1) {
    throw new AppError("В системе должен остаться хотя бы один администратор");
  }

  // Роли, разрыв сессий и след аудита — ОДНА транзакция: если след не запишется,
  // не изменятся и права (AGENTS.md, п. 4).
  const after = await getDocflowDb().transaction(async (tx) => {
    const roles = await setUserRoles(userId, roleIds, actor?.id ?? null, tx);
    // Права изменились — старые сессии несут устаревший набор прав.
    await revokeSessions(userId, tx);
    await insertAudit(
      {
        userId: actor?.id ?? null,
        userName: actorName(actor),
        action: "user.roles",
        entityType: "user",
        entityId: userId,
        oldValue: { roles: before },
        newValue: { roles }
      },
      tx
    );
    return roles;
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
  // ⚠️ Та же гонка, что и в assignRoles: проверка вне транзакции (см. countAdmins).
  if (blocked && (await getUserRoles(userId)).includes("admin") && (await countAdmins()) === 1) {
    throw new AppError("В системе должен остаться хотя бы один администратор");
  }

  // Блокировка, разрыв сессий и след — одна транзакция.
  return getDocflowDb().transaction(async (tx) => {
    const updated = (await updateUser(userId, { blocked }, tx))!;
    if (blocked) await revokeSessions(userId, tx);
    await insertAudit(
      {
        userId: actor?.id ?? null,
        userName: actorName(actor),
        action: blocked ? "user.block" : "user.unblock",
        entityType: "user",
        entityId: userId,
        oldValue: { blocked: user.blocked },
        newValue: { blocked }
      },
      tx
    );
    return updated;
  });
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

  const roles: string[] = [];
  for (const r of input.roleIds ?? []) {
    if (await getRole(r)) roles.push(r);
  }

  // Учётка, её роли и след создаются одной транзакцией: «пользователь есть,
  // а кто его завёл — неизвестно» недопустимо.
  return getDocflowDb().transaction(async (tx) => {
    const u = await insertUser(
      {
        email,
        fullName: (input.fullName ?? "").trim() || email,
        department: (input.department ?? "").trim(),
        position: (input.position ?? "").trim(),
        phone: (input.phone ?? "").trim(),
        source: "manual",
        isActive: true,
        passwordHash: null
      },
      tx
    );
    if (roles.length) await setUserRoles(u.id, roles, actor?.id ?? null, tx);
    await insertAudit(
      {
        userId: actor?.id ?? null,
        userName: actorName(actor),
        action: "user.create",
        entityType: "user",
        entityId: u.id,
        newValue: { email, fullName: u.fullName, roles }
      },
      tx
    );
    return { ...u, roles };
  });
}

export async function updateManualUser(
  userId: string,
  patch: { fullName?: string; department?: string; position?: string; phone?: string; email?: string },
  actor: AuthUser | null
): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new NotFoundError("Пользователь не найден");
  const before = { ...user };
  // Правка и след — одна транзакция.
  return getDocflowDb().transaction(async (tx) => {
    const updated = (await updateUser(userId, patch, tx))!;
    await insertAudit(
      {
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
      },
      tx
    );
    return updated;
  });
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

  // Вся синхронизация — одна транзакция: справочник и его след в аудите
  // обязаны появиться вместе, частично применённый справочник недопустим.
  const result = await getDocflowDb().transaction(async (tx) => {
    const res: SyncResult = { total: profiles.length, created: 0, updated: 0, deactivated: 0, linked: 0 };
    const seen = new Set<string>();

    for (const p of profiles) {
      seen.add(p.ldapUid.toLowerCase());
      const existing = await getUserByLdapUid(p.ldapUid, tx);
      if (existing) {
        await updateUser(
          existing.id,
          {
            ldapDn: p.dn || existing.ldapDn,
            email: p.email || existing.email,
            fullName: p.fullName || existing.fullName,
            department: p.department,
            position: p.position,
            phone: p.phone,
            managerDn: p.managerDn,
            // is_active следует за каталогом; ручную блокировку (blocked) синхронизация не трогает.
            isActive: !p.disabled
          },
          tx
        );
        res.updated++;
      } else {
        await insertUser(
          {
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
          },
          tx
        );
        res.created++;
      }
    }

    // Ушли из каталога — блокируем вход, но историю сохраняем (ТЗ п. 2 «Увольнение»).
    for (const u of await listUsersWithRoles({ includeInactive: false }, tx)) {
      if (u.source !== "ldap" || !u.ldapUid) continue;
      if (seen.has(u.ldapUid.toLowerCase())) continue;
      await updateUser(u.id, { isActive: false }, tx);
      await revokeSessions(u.id, tx);
      res.deactivated++;
    }

    // Связываем «руководитель → подчинённый» по DN.
    for (const u of await listUsersWithRoles({ includeInactive: true }, tx)) {
      if (!u.managerDn) continue;
      const mgr = await getUserByDn(u.managerDn, tx);
      if (mgr && mgr.id !== u.managerId) {
        await updateUser(u.id, { managerId: mgr.id }, tx);
        res.linked++;
      }
    }

    await insertAudit(
      {
        userId: actor?.id ?? null,
        userName: actorName(actor),
        action: "directory.sync",
        entityType: "user",
        newValue: res
      },
      tx
    );
    return res;
  });

  logger.info(result, "Синхронизация справочника сотрудников выполнена");
  return result;
}
