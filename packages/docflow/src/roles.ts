import type { AuthUser, BuiltinRoleId, Permission, UserWithRoles } from "./types.js";

/**
 * Права и роли.
 *
 * ⚠️ Роли БОЛЬШЕ НЕ ЗАШИТЫ В КОД: администратор заводит их сам и расставляет галочки прав
 * (конструктор ролей). Здесь остались только три вещи:
 *   • каталог прав — что ВООБЩЕ можно разрешить (его показывает интерфейс галочками);
 *   • встроенные описания пяти системных ролей — стартовые права и понятные названия;
 *   • реестр ролей в памяти, который docflow заполняет из базы при старте (installRoleStore).
 *
 * Права проверяются на сервере (requirePermission), UI лишь скрывает кнопки.
 */
export interface PermissionInfo {
  id: Permission;
  title: string;
  group: string;
}

/** Каталог прав: что можно разрешить роли. Группы — для порядка галочек в интерфейсе. */
export const PERMISSION_CATALOG: PermissionInfo[] = [
  { id: "journal.view", title: "Смотреть журнал", group: "Журнал" },
  { id: "journal.register", title: "Регистрировать документы", group: "Журнал" },
  { id: "journal.edit", title: "Править документы", group: "Журнал" },
  { id: "journal.archive", title: "Архивировать год", group: "Журнал" },
  { id: "journal.reopen", title: "Отменять закрытие года", group: "Журнал" },
  { id: "resolution.create", title: "Накладывать резолюцию", group: "Резолюции" },
  { id: "resolution.edit", title: "Править текст резолюции", group: "Резолюции" },
  { id: "resolution.approve", title: "Утверждать резолюцию", group: "Резолюции" },
  { id: "resolution.dispatch", title: "Отправлять резолюцию исполнителям", group: "Резолюции" },
  { id: "task.view", title: "Видеть поручения", group: "Поручения" },
  { id: "task.report", title: "Отчитываться об исполнении", group: "Поручения" },
  { id: "users.manage", title: "Управлять пользователями и ролями", group: "Администрирование" },
  { id: "settings.manage", title: "Менять настройки предприятия", group: "Администрирование" },
  { id: "audit.view", title: "Смотреть аудит", group: "Администрирование" },
  { id: "notifications.view", title: "Видеть центр уведомлений", group: "Уведомления" },
  { id: "mail.view", title: "Читать почту предприятия", group: "Почта" },
  { id: "mail.send", title: "Отправлять письма", group: "Почта" }
];

/** Все известные права — по каталогу. Незнакомое право в базе роль не даёт. */
export function allPermissions(): Permission[] {
  return PERMISSION_CATALOG.map((p) => p.id);
}

/** Роль так, как она живёт в базе (или во встроенном описании). */
export interface RoleRecord {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  sortOrder: number;
}

/** ID встроенных ролей: их засеивает миграция, у них есть стартовые права. */
export interface RoleDefinition {
  id: BuiltinRoleId;
  name: string;
  description: string;
  sortOrder: number;
  permissions: Permission[];
}

/**
 * Встроенные роли: СТАРТОВЫЕ права и понятные названия.
 *
 * Это не «зашитый список ролей»: роли живут в базе, администратор правит их галочками,
 * создаёт свои и удаляет лишние. Неизменяемым остаётся только «Администратор»
 * (allPermissions) — иначе систему некому было бы настроить.
 */
export const BUILTIN_ROLES: RoleRecord[] = [
  {
    id: "admin",
    name: "Администратор",
    description: "Полный доступ, управление пользователями и настройками",
    sortOrder: 10,
    permissions: allPermissions(),
    isSystem: true
  },
  {
    id: "secretary",
    name: "Секретарь / Аппарат",
    description: "Ведение журнала, регистрация и архивация документов",
    sortOrder: 20,
    // Черновик резолюции аппарат готовит (макет ген.дира), но утверждённый текст не правит —
    // это ограничение ТЗ п. 7, поэтому resolution.edit здесь нет.
    permissions: [
      "journal.view",
      "journal.register",
      "journal.edit",
      "journal.archive",
      "resolution.create",
      "resolution.dispatch",
      "task.view",
      "task.report",
      "notifications.view",
      "mail.view",
      "mail.send"
    ],
    isSystem: true
  },
  {
    id: "manager",
    name: "Руководитель",
    description: "Наложение резолюций и контроль исполнения",
    sortOrder: 30,
    permissions: [
      "journal.view",
      "resolution.create",
      "resolution.edit",
      "resolution.approve",
      "task.view",
      "notifications.view"
    ],
    isSystem: true
  },
  {
    id: "executor",
    name: "Исполнитель",
    description: "Получение задач и отчёт об исполнении",
    sortOrder: 40,
    permissions: ["journal.view", "task.view", "task.report", "notifications.view"],
    isSystem: true
  },
  {
    id: "signer",
    name: "Подписант",
    description: "Утверждение резолюций (ген.дир или тот, кому он делегировал право подписи)",
    sortOrder: 50,
    permissions: ["journal.view", "resolution.approve", "task.view", "notifications.view"],
    isSystem: true
  }
];

/** Прежнее имя встроенных описаний — оставлено для совместимости импортов и тестов. */
export const ROLE_DEFINITIONS: RoleDefinition[] = BUILTIN_ROLES as RoleDefinition[];

/** Реестр ролей: по умолчанию — встроенные, после старта docflow — прочитанные из базы. */
let registry: RoleRecord[] = BUILTIN_ROLES.map((r) => ({ ...r }));
let byId = new Map<string, RoleRecord>(registry.map((r) => [r.id, r]));

/** Заполняет реестр ролями из базы (вызывает docflow при старте). */
export function installRoleRegistry(list: RoleRecord[]): void {
  registry = list.map((r) => ({ ...r, permissions: [...r.permissions] }));
  byId = new Map(registry.map((r) => [r.id, r]));
}

/** Роли, как их видит интерфейс (и проверка прав). */
export function listRoleRecords(): RoleRecord[] {
  return registry.map((r) => ({ ...r, permissions: [...r.permissions] }));
}

/** Стартовые права встроенных ролей — для первичного засева в базе. */
export function builtinRoleDefaults(): RoleRecord[] {
  return BUILTIN_ROLES.map((r) => ({ ...r, permissions: [...r.permissions] }));
}

/** Права, которые даёт набор ролей (объединение). Незнакомая роль прав не даёт. */
export function permissionsOfRoles(roleIds: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const id of roleIds) {
    for (const p of byId.get(id)?.permissions ?? []) set.add(p);
  }
  return [...set];
}

export function hasPermission(user: AuthUser | null, permission: Permission): boolean {
  return !!user && user.permissions.includes(permission);
}

/** Человек считается администратором, если у него есть право управления пользователями. */
export function isAdmin(user: AuthUser | null): boolean {
  return hasPermission(user, "users.manage");
}

export function roleName(id: string): string {
  return byId.get(id)?.name ?? id;
}

/** Собирает AuthUser из записи пользователя и его ролей. */
export function buildAuthUser(user: Omit<UserWithRoles, "roles"> & { roles: string[] }): AuthUser {
  return { ...user, permissions: permissionsOfRoles(user.roles) };
}
