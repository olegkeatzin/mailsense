import { logger } from "@mailsense/core/directory";
import { getLdapSettings, directoryCredentials } from "@mailsense/core/directory";
import { ldapListProfiles } from "@mailsense/core/directory";
import type { LdapProfile } from "@mailsense/core/directory";
import {
  countActingAdmins,
  getRole,
  getUser,
  getUserByDn,
  getUserByEmail,
  getUserByLdapUid,
  getUserRoles,
  getUserWithRoles,
  insertAudit,
  insertUser,
  listRoles,
  listUsersWithRoles,
  lockAdminChanges,
  setUserRoles,
  updateUser,
  type DocflowTx,
  type ListUsersOptions
} from "./repo.js";
import { revokeSessions } from "./auth.js";
import { getDocflowDb } from "./db/index.js";
import { AppError, NotFoundError, isUniqueViolation } from "./errors.js";
import type { AuthUser, User, UserWithRoles } from "./types.js";

export { listUsersWithRoles, getUserWithRoles, listRoles };
export type { ListUsersOptions };

function actorName(actor: AuthUser | null): string {
  return actor ? actor.fullName || actor.email : "система";
}

/**
 * Конфликт email на уровне базы — понятным текстом.
 *
 * Проверка «нет ли такого адреса» в коде гонку не закрывает: два одновременных
 * запроса проходят её оба. Конфликт ловит уникальный индекс (users_email_uniq_idx),
 * а наружу он должен уходить тем же текстом, что и обычная проверка.
 */
function duplicateEmailError(err: unknown, email: string): unknown {
  return isUniqueViolation(err)
    ? new AppError("Пользователь с таким email уже есть: " + email, 409, "duplicate_email")
    : err;
}

/**
 * Инвариант «в системе должен остаться хотя бы один действующий администратор».
 *
 * «Действующий» — тот, кто реально может войти: роль admin, is_active и не blocked
 * (см. countActingAdmins в repo.ts). Уволенный в каталоге или заблокированный
 * администратором прав не удерживает: иначе правило выполнялось бы тем, кто в систему
 * не войдёт, и система осталась бы без администратора через другую дверь.
 *
 * Замок смены администраторов (lockAdminChanges) берётся ПЕРВЫМ действием транзакции:
 * под READ COMMITTED две транзакции не видят незакоммиченных изменений друг друга,
 * поэтому без замка обе одновременные проверки видят «двоих» и проходят обе.
 * Строки пользователей до замка не блокируются — обратный порядок дал бы взаимную
 * блокировку с синхронизацией справочника.
 */

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

  // Роли, разрыв сессий и след аудита — ОДНА транзакция: если след не запишется,
  // не изменятся и права (AGENTS.md, п. 4). Проверка «останется хотя бы один
  // администратор» живёт здесь же — под общим замком смены администраторов.
  const after = await getDocflowDb().transaction(async (tx) => {
    // Замок — первым действием: строки пользователей не блокируем (см. lockAdminChanges).
    await lockAdminChanges(tx);

    // Набор ролей читаем внутри транзакции: он нужен и аудиту, и проверке, и обязан
    // быть на момент изменения, а не до взятия замка.
    const before = await getUserRoles(userId, tx);
    // Администратором считается только тот, кто может войти: уволенный в каталоге
    // (is_active = false) или заблокированный прав не удерживает.
    const wasAdmin = before.includes("admin") && user.isActive && !user.blocked;
    const willBeAdmin = roleIds.includes("admin");
    // Замок держится до конца транзакции, поэтому между пересчётом и записью никто не
    // вклинится: два одновременных снятия прав у двух последних администраторов идут
    // по очереди, и второе получает отказ.
    if (wasAdmin && !willBeAdmin && (await countActingAdmins(tx)) === 1) {
      throw new AppError("В системе должен остаться хотя бы один администратор");
    }

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
  // Блокировка, разрыв сессий и след — одна транзакция; проверка «останется хотя бы
  // один администратор» — там же, под общим замком смены администраторов.
  return getDocflowDb().transaction(async (tx) => {
    if (blocked) {
      // Замок — первым действием: строки пользователей не блокируем (см. lockAdminChanges).
      await lockAdminChanges(tx);
      const roles = await getUserRoles(userId, tx);
      // Блокируем действующего администратора: уволенный или уже заблокированный
      // счёт не держит, его блокировка ничего не ухудшает.
      const actingAdmin = user.isActive && !user.blocked && roles.includes("admin");
      if (actingAdmin && (await countActingAdmins(tx)) === 1) {
        throw new AppError("В системе должен остаться хотя бы один администратор");
      }
    }
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
  // Точечная проверка ради понятного текста; окончательную гарантию даёт уникальный
  // индекс users_email_uniq_idx — две одновременные заявки проходят проверку обе,
  // и конфликт ловит база (см. обработку ниже).
  if (await getUserByEmail(email)) {
    throw new AppError("Пользователь с таким email уже есть: " + email, 409, "duplicate_email");
  }

  const roles: string[] = [];
  for (const r of input.roleIds ?? []) {
    if (await getRole(r)) roles.push(r);
  }

  // Учётка, её роли и след создаются одной транзакцией: «пользователь есть,
  // а кто его завёл — неизвестно» недопустимо.
  try {
    return await getDocflowDb().transaction(async (tx) => {
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
  } catch (err) {
    // Гонка двух одновременных заявок: проверка выше обе прошла, конфликт поймала база.
    throw duplicateEmailError(err, email);
  }
}

export async function updateManualUser(
  userId: string,
  patch: { fullName?: string; department?: string; position?: string; phone?: string; email?: string },
  actor: AuthUser | null
): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new NotFoundError("Пользователь не найден");

  // Email правится только на свободный: иначе в справочнике появился бы второй
  // человек с тем же адресом (адрес — ключ, по которому ищут учётку).
  const nextEmail = patch.email !== undefined ? (patch.email ?? "").trim() : undefined;
  const effective = nextEmail === undefined ? patch : { ...patch, email: nextEmail };
  if (nextEmail) {
    const owner = await getUserByEmail(nextEmail);
    if (owner && owner.id !== userId) {
      throw new AppError("Пользователь с таким email уже есть: " + nextEmail, 409, "duplicate_email");
    }
  }

  const before = { ...user };
  // Правка и след — одна транзакция.
  try {
    return await getDocflowDb().transaction(async (tx) => {
      const updated = (await updateUser(userId, effective, tx))!;
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
          newValue: effective
        },
        tx
      );
      return updated;
    });
  } catch (err) {
    // Гонка: проверка выше прошла, конфликт с уникальным индексом поймала база.
    throw duplicateEmailError(err, nextEmail ?? "");
  }
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  linked: number;
  /** Адреса из каталога, которые не удалось применить: их уже занимает другая учётка. */
  emailConflicts: Array<{ ldapUid: string; email: string }>;
  /** Список каталога неполный или недостоверный — деактивация пропущена. */
  incomplete: boolean;
}

/**
 * Применяет одну запись каталога.
 *
 * ⚠️ Каждая запись — в своём savepoint. Нарушение уникальности внутри общей транзакции
 * отравляет её целиком («current transaction is aborted»), и тогда одна плохая запись
 * в каталоге не дала бы обновить справочник вообще — именно так дубль адреса ронял всю
 * синхронизацию и отдавал наружу 500.
 *
 * Конфликт адреса (занят другой учёткой: общий ящик, контрагент, запись, заведённая
 * вручную) кадровые данные не отменяет: человека заводим или обновляем, но чужой адрес
 * не отбираем и не дублируем. О конфликте сообщаем в отчёте — разбираться человеку.
 */
async function applyDirectoryProfile(
  tx: DocflowTx,
  p: LdapProfile,
  existing: User | null
): Promise<{ created: boolean; emailConflict: boolean }> {
  const email = (p.email ?? "").trim();
  const fields = {
    ldapDn: p.dn || existing?.ldapDn || null,
    fullName: p.fullName || existing?.fullName || "",
    department: p.department,
    position: p.position,
    phone: p.phone,
    managerDn: p.managerDn,
    // is_active следует за каталогом; ручную блокировку (blocked) синхронизация не трогает.
    isActive: !p.disabled
  };
  /** То же самое, но без адреса: чужой адрес не занимаем. */
  const withoutEmail = async (): Promise<void> => {
    await tx.transaction(async (sp) => {
      if (existing) await updateUser(existing.id, fields, sp);
      else await insertUser({ ...fields, ldapUid: p.ldapUid, email: "", source: "ldap" }, sp);
    });
  };

  try {
    await tx.transaction(async (sp) => {
      if (existing) await updateUser(existing.id, { ...fields, email: email || existing.email }, sp);
      else await insertUser({ ...fields, ldapUid: p.ldapUid, email, source: "ldap" }, sp);
    });
    return { created: !existing, emailConflict: false };
  } catch (err) {
    // Конфликт адреса — не повод терять кадровые данные и не повод ронять синхронизацию.
    if (!isUniqueViolation(err) || !email) throw err;
    await withoutEmail();
    return { created: !existing, emailConflict: true };
  }
}

/**
 * Синхронизация справочника сотрудников из LDAP.
 * LDAP — источник истины для кадровых данных: ФИО, email, отдел, должность, руководитель.
 * Роли не трогаем — они живут в базе документооборота (ТЗ п. 2).
 * Сотрудники, исчезнувшие из каталога, помечаются is_active = false (история сохраняется).
 */
/**
 * Пауза после отказа каталога.
 *
 * ⚠️ На проде служебная учётная запись получала AD-ошибку 775 (заблокирована), а каждая
 * следующая попытка синхронизации снова шла в bind — учётку добивало до полного lockout,
 * и вместе с ней падал выбор исполнителей. Теперь после такой ошибки 5 минут не пытаемся.
 */
const DIRECTORY_PAUSE_MS = 5 * 60 * 1000;
let directoryPause: { until: number; message: string } | null = null;

/** Сбросить паузу: после смены настроек каталога и в тестах. */
export function resetDirectorySyncPause(): void {
  directoryPause = null;
}

/**
 * Отказ служебной учётной записи — это состояние каталога, а не сбой сервера.
 * Наружу должен уйти понятный текст (409), а не 500 с «data 775».
 */
function directorySyncFailure(err: unknown): unknown {
  const kind = (err as { kind?: string } | null)?.kind;
  const readable = err instanceof Error ? err.message : String(err);
  const message = "Синхронизация каталога не выполнена: " + readable;
  if (kind === "account_locked" || kind === "invalid_credentials" || kind === "password_expired") {
    directoryPause = {
      until: Date.now() + DIRECTORY_PAUSE_MS,
      message: message + ". Повтор через 5 минут, чтобы не заблокировать учётную запись окончательно"
    };
  }
  if (kind) return new AppError(message, 409, "directory_sync_" + kind);
  return err;
}

export async function syncDirectoryUsers(actor: AuthUser | null): Promise<SyncResult> {
  if (directoryPause && Date.now() < directoryPause.until) {
    throw new AppError(directoryPause.message, 409, "directory_sync_paused");
  }

  const cred = directoryCredentials();
  if (!cred) throw new AppError("Сначала войдите в каталог: «Настройки → Каталог (LDAP)»");

  const s = getLdapSettings();
  // Предел выгрузки не задаём: берётся дефолт каталога (core). Свой предел здесь
  // означал бы, что на справочнике больше него уволенных НИКОГДА не отключат —
  // и никто не поймёт почему. Признак обрезки приходит отдельно (truncated).
  let listing: Awaited<ReturnType<typeof ldapListProfiles>>;
  try {
    listing = await ldapListProfiles(s, cred.login, cred.password);
  } catch (err) {
    throw directorySyncFailure(err);
  }
  const { profiles, total, truncated } = listing;

  // ⚠️ Неполный список нельзя принимать за «этих людей в каталоге больше нет»:
  // деактивация выключила бы живых сотрудников и разорвала им сессии. Обрезка по
  // пределу выгрузки — прямой признак; пустой ответ — почти всегда неверный Base DN,
  // а не вымерший дом, и доверия к нему ровно столько же.
  const incomplete = truncated || total === 0;
  if (incomplete) {
    logger.warn(
      { total, got: profiles.length, truncated },
      "Список каталога неполный — деактивация сотрудников пропущена"
    );
  }

  // Вся синхронизация — одна транзакция: справочник и его след в аудите
  // обязаны появиться вместе, частично применённый справочник недопустим.
  const result = await getDocflowDb().transaction(async (tx) => {
    const res: SyncResult = {
      total: profiles.length,
      created: 0,
      updated: 0,
      deactivated: 0,
      linked: 0,
      emailConflicts: [],
      incomplete
    };
    const seen = new Set<string>();

    for (const p of profiles) {
      seen.add(p.ldapUid.toLowerCase());
      const existing = await getUserByLdapUid(p.ldapUid, tx);
      const applied = await applyDirectoryProfile(tx, p, existing);
      if (applied.created) res.created++;
      else res.updated++;
      if (applied.emailConflict) {
        res.emailConflicts.push({ ldapUid: p.ldapUid, email: (p.email ?? "").trim() });
      }
    }

    // Ушли из каталога — блокируем вход, но историю сохраняем (ТЗ п. 2 «Увольнение»).
    // Только по полному списку: при incomplete отсутствие в списке ничего не доказывает.
    if (!incomplete) {
      for (const u of await listUsersWithRoles({ includeInactive: false }, tx)) {
        if (u.source !== "ldap" || !u.ldapUid) continue;
        if (seen.has(u.ldapUid.toLowerCase())) continue;
        await updateUser(u.id, { isActive: false }, tx);
        await revokeSessions(u.id, tx);
        res.deactivated++;
      }
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
