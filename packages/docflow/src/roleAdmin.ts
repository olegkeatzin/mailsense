import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { auditInTx } from "./audit.js";
import type { Actor } from "./journal.js";
import { allPermissions, builtinRoleDefaults, installRoleRegistry, type RoleRecord } from "./roles.js";
import type { Permission } from "./types.js";

/**
 * Конструктор ролей: роли и их права живут в базе, администратор заводит их сам.
 *
 * ⚠️ Роль — единственный источник прав пользователя (роль → права → requirePermission).
 * Поэтому после каждой правки реестр в памяти перечитывается: иначе новые права вступали бы
 * в силу только после перезапуска сервера.
 *
 * ⚠️ Роль «Администратор» (id = admin) неизменяема и всегда даёт все права. Иначе
 * администратор мог бы снять права у себя и остаться без возможности их вернуть.
 */
export const ROLE_AUDIT_ACTION = "role.change";

/** Отказ по данным роли: это 400-класс, а не сбой сервера. */
export class RoleInputError extends Error {
  readonly code: string;
  constructor(message: string, code = "role.invalid") {
    super(message);
    this.name = "RoleInputError";
    this.code = code;
  }
}

const { roles, userRoles } = docflowSchema;

/** Права из JSON: незнакомое право роль не даёт (каталог — источник правды). */
export function parseRolePermissions(raw: string | null | undefined): Permission[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = new Set<string>(allPermissions());
    return parsed.filter((p): p is Permission => typeof p === "string" && known.has(p));
  } catch {
    return [];
  }
}

function mapRecord(row: typeof roles.$inferSelect): RoleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: parseRolePermissions(row.permissions),
    isSystem: row.isSystem,
    sortOrder: row.sortOrder
  };
}

export async function listRolesFromDb(): Promise<RoleRecord[]> {
  const rows = await getDocflowDb().select().from(roles).orderBy(asc(roles.sortOrder));
  return rows.map(mapRecord);
}

/**
 * Встроенным ролям без прав (permissions IS NULL) подставляем стартовые.
 * Пустой список '[]' не трогаем: это осознанное «прав нет».
 */
async function seedBuiltinPermissions(): Promise<void> {
  for (const role of builtinRoleDefaults()) {
    await getDocflowDb()
      .update(roles)
      .set({ permissions: JSON.stringify(role.permissions) })
      .where(and(eq(roles.id, role.id), isNull(roles.permissions)));
  }
}

/** Ставит реестр ролей из базы: после этого permissionsOfRoles считает права по базе. */
export async function installRoleStore(): Promise<void> {
  await seedBuiltinPermissions();
  installRoleRegistry(await listRolesFromDb());
}

function readName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new RoleInputError("Укажите название роли", "role.name_required");
  if (name.length > 80) throw new RoleInputError("Название роли: не длиннее 80 символов", "role.name_too_long");
  return name;
}

function readPermissions(raw: unknown): Permission[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RoleInputError("Права — список значений", "role.bad_permissions");
  const known = new Set<string>(allPermissions());
  const out: Permission[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !known.has(value)) {
      throw new RoleInputError("Неизвестное право: " + String(value), "role.unknown_permission");
    }
    const permission = value as Permission;
    if (!out.includes(permission)) out.push(permission);
  }
  return out;
}

/**
 * Идентификатор роли из названия (латиница/цифры). Кириллическое название даёт случайный id —
 * роль всё равно видна и выбирается по названию, а id нужен только базе.
 */
function idFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "role-" + randomUUID().slice(0, 8);
}

/** Заводит роль. */
export async function createRole(
  input: { name?: unknown; description?: unknown; permissions?: unknown },
  actor: Actor
): Promise<RoleRecord> {
  const name = readName(input.name);
  const permissions = readPermissions(input.permissions);
  const description = String(input.description ?? "").trim();
  const db = getDocflowDb();
  const existing = await db.select().from(roles);
  const id = idFromName(name);
  if (existing.some((r) => r.id === id)) {
    throw new RoleInputError("Роль с таким названием уже есть: " + name, "role.exists");
  }
  const sortOrder = existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;

  await db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id,
      name,
      description,
      sortOrder,
      isSystem: false,
      permissions: JSON.stringify(permissions)
    });
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: ROLE_AUDIT_ACTION,
      entityType: "role",
      entityId: id,
      oldValue: JSON.stringify({}),
      newValue: JSON.stringify({ name, permissions })
    });
  });

  installRoleRegistry(await listRolesFromDb());
  const created = (await listRolesFromDb()).find((r) => r.id === id);
  if (!created) throw new RoleInputError("Роль не сохранилась: " + name, "role.not_saved");
  return created;
}

/** Меняет название, описание и права роли. */
export async function updateRole(
  id: string,
  patch: { name?: unknown; description?: unknown; permissions?: unknown },
  actor: Actor
): Promise<RoleRecord> {
  const roleId = String(id ?? "").trim();
  const db = getDocflowDb();
  const rows = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  const current = rows[0];
  if (!current) throw new RoleInputError("Роль не найдена: " + roleId, "role.not_found");
  if (current.id === "admin") {
    throw new RoleInputError(
      "Роль «Администратор» изменить нельзя: она всегда даёт все права",
      "role.admin_immutable"
    );
  }

  const name = patch.name === undefined ? current.name : readName(patch.name);
  const description = patch.description === undefined ? current.description : String(patch.description ?? "").trim();
  const permissions =
    patch.permissions === undefined ? parseRolePermissions(current.permissions) : readPermissions(patch.permissions);

  await db.transaction(async (tx) => {
    await tx
      .update(roles)
      .set({ name, description, permissions: JSON.stringify(permissions) })
      .where(eq(roles.id, roleId));
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: ROLE_AUDIT_ACTION,
      entityType: "role",
      entityId: roleId,
      oldValue: JSON.stringify({ name: current.name, permissions: parseRolePermissions(current.permissions) }),
      newValue: JSON.stringify({ name, permissions })
    });
  });

  installRoleRegistry(await listRolesFromDb());
  const updated = (await listRolesFromDb()).find((r) => r.id === roleId);
  if (!updated) throw new RoleInputError("Роль не найдена: " + roleId, "role.not_found");
  return updated;
}

/** Удаляет роль. Назначенную роль удалять нельзя: сначала снимите её у работников. */
export async function deleteRole(id: string, actor: Actor): Promise<void> {
  const roleId = String(id ?? "").trim();
  const db = getDocflowDb();
  const rows = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  const current = rows[0];
  if (!current) throw new RoleInputError("Роль не найдена: " + roleId, "role.not_found");
  if (current.isSystem) {
    throw new RoleInputError("Системную роль удалить нельзя: " + current.name, "role.system");
  }

  const assigned = await db.select().from(userRoles).where(eq(userRoles.roleId, roleId));
  if (assigned.length) {
    throw new RoleInputError(
      "Роль назначена работникам (" +
        assigned.length +
        "). Сначала снимите её в списке пользователей, потом удаляйте",
      "role.assigned"
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(roles).where(eq(roles.id, roleId));
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: ROLE_AUDIT_ACTION,
      entityType: "role",
      entityId: roleId,
      oldValue: JSON.stringify({ name: current.name, permissions: parseRolePermissions(current.permissions) }),
      newValue: JSON.stringify({})
    });
  });

  installRoleRegistry(await listRolesFromDb());
}
