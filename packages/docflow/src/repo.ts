import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { getDocflowDb, type DocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { AppError } from "./errors.js";
import type {
  AuditEntry,
  AuditFilter,
  AuditInput,
  Role,
  User,
  UserSource,
  UserWithRoles
} from "./types.js";

const { users, roles, userRoles, sessions, auditLog } = docflowSchema;

/**
 * Исполнитель запроса: сама база или транзакция.
 *
 * Изменение и его след в аудите обязаны быть одной транзакцией (AGENTS.md, п. 4):
 * если след не записался, изменения быть не должно. Поэтому операции репозитория
 * принимают необязательный исполнитель — внутри транзакции он передаётся дальше.
 */
export type DocflowTx = Parameters<Parameters<DocflowDb["transaction"]>[0]>[0];
export type DocflowExecutor = DocflowDb | DocflowTx;

/** База или переданная транзакция. */
function executor(exec?: DocflowExecutor): DocflowExecutor {
  return exec ?? getDocflowDb();
}

/**
 * count(*) в PostgreSQL приходит как bigint (строкой), поэтому приводим к int
 * прямо в запросе — иначе наружу утекут строки вместо чисел.
 */
const countExpr = sql<number>`count(*)::int`;

function now(): string {
  return new Date().toISOString();
}

/**
 * Замок «смена администраторов».
 *
 * Любая операция, которая может оставить систему без действующего администратора
 * (снятие роли, блокировка, удаление учётки), обязана взять этот замок ПЕРВЫМ
 * действием своей транзакции и проверить инвариант под ним. Иначе две одновременные
 * операции не видят незакоммиченных изменений друг друга и проходят обе — система
 * остаётся без того, кому выдавать права, и лечится это только правкой базы руками.
 *
 * ⚠️ Строки пользователей до замка НЕ блокируются: полная синхронизация справочника
 * держит их пачкой в своей транзакции, и обратный порядок блокировок дал бы взаимную
 * блокировку (deadlock). pg_advisory_xact_lock отпускается сам при COMMIT и ROLLBACK,
 * поэтому отказ в правах не оставляет систему запертой.
 */
export const ADMIN_CHANGES_LOCK_KEY = 0x41444d31; // "ADM1"

/** Берёт замок смены администраторов на время текущей транзакции. */
export async function lockAdminChanges(tx: DocflowExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_CHANGES_LOCK_KEY}::bigint)`);
}

/**
 * Сколько в системе администраторов, которые реально могут войти: роль admin,
 * is_active и не blocked.
 *
 * ⚠️ Засчитывать администратора, который войти не может, нельзя. Уволенный в каталоге
 * (is_active = false) или заблокированный прав не удерживает: иначе правило «должен
 * остаться хотя бы один администратор» выполнялось бы тем, кто в систему не войдёт,
 * и система оставалась бы без администратора ровно так же, просто через другую дверь.
 *
 * Читать это число можно только под замком смены администраторов и в той же
 * транзакции, что и изменение.
 */
export async function countActingAdmins(exec?: DocflowExecutor): Promise<number> {
  const db = executor(exec);
  const rows = await db
    .select({ n: countExpr })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        eq(users.blocked, false),
        inArray(
          users.id,
          db.select({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, "admin"))
        )
      )
    );
  return rows[0]?.n ?? 0;
}

// ---------------- Users ----------------

export function mapUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    ldapUid: row.ldapUid,
    ldapDn: row.ldapDn,
    email: row.email,
    fullName: row.fullName,
    department: row.department,
    position: row.position,
    managerDn: row.managerDn,
    managerId: row.managerId,
    phone: row.phone,
    source: row.source as UserSource,
    isActive: row.isActive,
    blocked: row.blocked,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** Ключ поиска логина: нижний регистр средствами JS (lower() в СУБД зависит от локали). */
export function uidKey(ldapUid: string | null | undefined): string | null {
  const v = (ldapUid ?? "").trim();
  return v ? v.toLowerCase() : null;
}

export async function countUsers(): Promise<number> {
  const rows = await getDocflowDb().select({ n: countExpr }).from(users);
  return rows[0]?.n ?? 0;
}

export async function getUser(id: string, exec?: DocflowExecutor): Promise<User | null> {
  const rows = await executor(exec).select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Поиск по sAMAccountName без учёта регистра.
 * Сравнение идёт по нормализованному ключу: логины AD кириллические («Иванов_ИИ»),
 * а регистронезависимость средствами СУБД зависит от локали.
 */
export async function getUserByLdapUid(ldapUid: string, exec?: DocflowExecutor): Promise<User | null> {
  const key = uidKey(ldapUid);
  if (!key) return null;
  const rows = await executor(exec).select().from(users).where(eq(users.ldapUidKey, key)).limit(1);
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Поиск по email: точное совпадение либо регистронезависимое (адреса латиницей). */
export async function getUserByEmail(email: string): Promise<User | null> {
  const v = (email ?? "").trim();
  if (!v) return null;
  const rows = await getDocflowDb()
    .select()
    .from(users)
    .where(or(eq(users.email, v), sql`lower(${users.email}) = ${v.toLowerCase()}`))
    .limit(1);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function getUserByDn(dn: string, exec?: DocflowExecutor): Promise<User | null> {
  if (!dn) return null;
  const rows = await executor(exec).select().from(users).where(eq(users.ldapDn, dn)).limit(1);
  return rows[0] ? mapUser(rows[0]) : null;
}

export interface InsertUserInput {
  ldapUid?: string | null;
  ldapDn?: string | null;
  email: string;
  fullName?: string;
  department?: string;
  position?: string;
  managerDn?: string | null;
  managerId?: string | null;
  phone?: string;
  source?: UserSource;
  passwordHash?: string | null;
  isActive?: boolean;
  blocked?: boolean;
}

export async function insertUser(u: InsertUserInput, exec?: DocflowExecutor): Promise<User> {
  const id = randomUUID();
  const ts = now();
  await executor(exec)
    .insert(users)
    .values({
      id,
      ldapUid: u.ldapUid ?? null,
      ldapUidKey: uidKey(u.ldapUid),
      ldapDn: u.ldapDn ?? null,
      email: u.email ?? "",
      fullName: u.fullName ?? "",
      department: u.department ?? "",
      position: u.position ?? "",
      managerDn: u.managerDn ?? null,
      managerId: u.managerId ?? null,
      phone: u.phone ?? "",
      source: u.source ?? "ldap",
      passwordHash: u.passwordHash ?? null,
      isActive: u.isActive ?? true,
      blocked: false,
      lastLoginAt: null,
      createdAt: ts,
      updatedAt: ts
    });
  return (await getUser(id, exec))!;
}

export interface UpdateUserPatch {
  ldapUid?: string | null;
  ldapDn?: string | null;
  email?: string;
  fullName?: string;
  department?: string;
  position?: string;
  managerDn?: string | null;
  managerId?: string | null;
  phone?: string;
  isActive?: boolean;
  blocked?: boolean;
  passwordHash?: string | null;
  source?: UserSource;
}

/**
 * Хэш пароля локальной учётки. Намеренно не входит в доменный тип User:
 * наружу (в API и UI) хэш не отдаётся никогда.
 */
export async function getUserPasswordHash(userId: string): Promise<string | null> {
  const rows = await getDocflowDb()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.passwordHash ?? null;
}

export async function updateUser(
  id: string,
  patch: UpdateUserPatch,
  exec?: DocflowExecutor
): Promise<User | null> {
  const set: Record<string, unknown> = { updatedAt: now() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  // Ключ поиска пересчитываем вместе с логином, иначе поиск разъедется с данными.
  if (patch.ldapUid !== undefined) set.ldapUidKey = uidKey(patch.ldapUid);
  await executor(exec).update(users).set(set).where(eq(users.id, id));
  return getUser(id, exec);
}

export async function touchLastLogin(id: string): Promise<void> {
  const ts = now();
  await getDocflowDb().update(users).set({ lastLoginAt: ts, updatedAt: ts }).where(eq(users.id, id));
}

/**
 * Удаление учётки.
 *
 * Роли уходят каскадом, поэтому удаление администратора — такая же смена прав, как
 * assignRoles: последнего действующего администратора удалять нельзя, иначе выдавать
 * права станет некому. Операция берёт тот же замок смены администраторов и проверяет
 * инвариант под ним. Функция публичная: следующий, кто её позовёт, не должен получить
 * эту дыру обратно.
 */
export async function deleteUser(id: string): Promise<void> {
  await getDocflowDb().transaction(async (tx) => {
    // Замок — первым действием: строки пользователей не блокируем (см. ADMIN_CHANGES_LOCK_KEY).
    await lockAdminChanges(tx);
    const user = await getUser(id, tx);
    if (user && user.isActive && !user.blocked && (await getUserRoles(id, tx)).includes("admin")) {
      if ((await countActingAdmins(tx)) === 1) {
        throw new AppError("В системе должен остаться хотя бы один администратор");
      }
    }
    await tx.delete(users).where(eq(users.id, id));
  });
}

// ---------------- Roles ----------------

export function mapRole(row: typeof roles.$inferSelect): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    isSystem: row.isSystem
  };
}

export async function listRoles(): Promise<Role[]> {
  const rows = await getDocflowDb().select().from(roles).orderBy(asc(roles.sortOrder));
  return rows.map(mapRole);
}

export async function getRole(id: string): Promise<Role | null> {
  const rows = await getDocflowDb().select().from(roles).where(eq(roles.id, id)).limit(1);
  return rows[0] ? mapRole(rows[0]) : null;
}

export async function getUserRoles(userId: string, exec?: DocflowExecutor): Promise<string[]> {
  const rows = await executor(exec)
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleId);
}

/** Роли сразу для набора пользователей — чтобы не делать N запросов в списке. */
export async function rolesForUsers(userIds: string[], exec?: DocflowExecutor): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!userIds.length) return map;
  const rows = await executor(exec)
    .select({ userId: userRoles.userId, roleId: userRoles.roleId })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds));
  for (const r of rows) {
    const arr = map.get(r.userId) ?? [];
    arr.push(r.roleId);
    map.set(r.userId, arr);
  }
  return map;
}

/**
 * Полная замена набора ролей пользователя.
 *
 * Без переданной транзакции создаёт свою; внутри чужой — работает в ней, чтобы
 * смена ролей и её след в аудите откатывались вместе.
 */
export async function setUserRoles(
  userId: string,
  roleIds: string[],
  grantedBy?: string | null,
  exec?: DocflowExecutor
): Promise<string[]> {
  const ts = now();
  const run = async (tx: DocflowExecutor): Promise<void> => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    for (const roleId of [...new Set(roleIds)]) {
      await tx
        .insert(userRoles)
        .values({ userId, roleId, grantedAt: ts, grantedBy: grantedBy ?? null })
        .onConflictDoNothing();
    }
  };
  if (exec) {
    await run(exec);
  } else {
    await getDocflowDb().transaction(run);
  }
  return getUserRoles(userId, exec);
}

export async function grantRole(userId: string, roleId: string, grantedBy?: string | null): Promise<void> {
  await getDocflowDb()
    .insert(userRoles)
    .values({ userId, roleId, grantedAt: now(), grantedBy: grantedBy ?? null })
    .onConflictDoNothing();
}

// ---------------- Users + roles ----------------

export interface ListUsersOptions {
  q?: string;
  roleId?: string;
  includeInactive?: boolean;
  limit?: number;
}

/**
 * Справочник пользователей с ролями.
 *
 * Фильтры и limit выполняет СУБД. Прежняя версия вытаскивала всю таблицу users
 * в память, фильтровала и «пагинировала» в JS: на справочнике в тысячи человек
 * каждый вызов /api/users (и каждая проверка hasAdmin) стоил полной выборки,
 * а limit не уменьшал ни одной строки в памяти.
 */
export async function listUsersWithRoles(
  opts: ListUsersOptions = {},
  exec?: DocflowExecutor
): Promise<UserWithRoles[]> {
  const db = executor(exec);
  const conditions = [];

  if (!opts.includeInactive) conditions.push(eq(users.isActive, true));

  if (opts.roleId) {
    // Подзапрос, а не join: пользователь с ролью должен вернуться ровно один раз.
    conditions.push(
      inArray(
        users.id,
        db.select({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, opts.roleId))
      )
    );
  }

  const q = (opts.q ?? "").trim();
  if (q) {
    // % и _ — символы поиска, а не шаблоны: иначе запрос «%» показал бы весь справочник.
    const like = "%" + q.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
    conditions.push(
      or(
        ilike(users.fullName, like),
        ilike(users.email, like),
        ilike(users.ldapUid, like),
        ilike(users.department, like),
        ilike(users.position, like)
      )
    );
  }

  const base = db.select().from(users);
  const filtered = conditions.length ? base.where(and(...conditions)) : base;
  const ordered = filtered.orderBy(asc(users.fullName), asc(users.email));
  const rows = opts.limit && opts.limit > 0 ? await ordered.limit(opts.limit) : await ordered;

  const list = rows.map(mapUser);
  const roleMap = await rolesForUsers(list.map((u) => u.id), exec);
  return list.map((u) => ({ ...u, roles: roleMap.get(u.id) ?? [] }));
}

export async function getUserWithRoles(id: string): Promise<UserWithRoles | null> {
  const u = await getUser(id);
  if (!u) return null;
  return { ...u, roles: await getUserRoles(id) };
}

/** Пользователи с указанной ролью — для рассылки уведомлений (например, всему аппарату). */
export async function listUsersByRole(roleId: string): Promise<User[]> {
  const rows = await getDocflowDb()
    .select({ user: users })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, roleId), eq(users.isActive, true), eq(users.blocked, false)));
  return rows.map((r) => mapUser(r.user));
}

// ---------------- Sessions ----------------

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
}

export async function insertSession(s: SessionRecord): Promise<void> {
  await getDocflowDb().insert(sessions).values(s);
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  const rows = await getDocflowDb().select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function touchSession(id: string): Promise<void> {
  await getDocflowDb().update(sessions).set({ lastSeenAt: now() }).where(eq(sessions.id, id));
}

export async function deleteSession(id: string): Promise<void> {
  await getDocflowDb().delete(sessions).where(eq(sessions.id, id));
}

export async function deleteSessionsForUser(userId: string, exec?: DocflowExecutor): Promise<number> {
  const rows = await executor(exec).select({ n: countExpr }).from(sessions).where(eq(sessions.userId, userId));
  await executor(exec).delete(sessions).where(eq(sessions.userId, userId));
  return rows[0]?.n ?? 0;
}

export async function purgeExpiredSessions(): Promise<number> {
  const ts = now();
  const rows = await getDocflowDb().select({ n: countExpr }).from(sessions).where(lte(sessions.expiresAt, ts));
  await getDocflowDb().delete(sessions).where(lte(sessions.expiresAt, ts));
  return rows[0]?.n ?? 0;
}

// ---------------- Audit ----------------

function stringify(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function insertAudit(a: AuditInput, exec?: DocflowExecutor): Promise<AuditEntry> {
  const id = randomUUID();
  const ts = now();
  const entry: AuditEntry = {
    id,
    userId: a.userId ?? null,
    userName: a.userName ?? "",
    action: a.action,
    entityType: a.entityType ?? "",
    entityId: a.entityId ?? "",
    oldValue: stringify(a.oldValue),
    newValue: stringify(a.newValue),
    createdAt: ts
  };
  await executor(exec).insert(auditLog).values(entry);
  return entry;
}

function auditConditions(filter: AuditFilter) {
  const conditions = [];
  if (filter.userId) conditions.push(eq(auditLog.userId, filter.userId));
  if (filter.entityType) conditions.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditLog.entityId, filter.entityId));
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.dateFrom) conditions.push(gte(auditLog.createdAt, filter.dateFrom));
  if (filter.dateTo) conditions.push(lte(auditLog.createdAt, filter.dateTo + "T23:59:59.999Z"));
  return conditions;
}

export async function listAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const conditions = auditConditions(filter);
  const base = getDocflowDb().select().from(auditLog);
  const rows = await (conditions.length ? base.where(and(...conditions)) : base)
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(1000, Math.max(1, filter.limit ?? 200)))
    .offset(Math.max(0, filter.offset ?? 0));
  return rows.map((r) => ({ ...r }));
}

export async function countAudit(filter: AuditFilter = {}): Promise<number> {
  const conditions = auditConditions(filter);
  const base = getDocflowDb().select({ n: countExpr }).from(auditLog);
  const rows = await (conditions.length ? base.where(and(...conditions)) : base);
  return rows[0]?.n ?? 0;
}
