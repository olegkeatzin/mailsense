import type { AuthUser, BuiltinRoleId, Permission, UserWithRoles } from "./types.js";

/**
 * Встроенные роли и их права.
 *
 * Ключевые ограничения из ТЗ (п. 7 «Безопасность»):
 *   - Руководитель НЕ редактирует журнал → у manager нет journal.edit/journal.register;
 *   - Аппарат НЕ меняет текст резолюции → у secretary нет resolution.edit.
 * Права проверяются на сервере (requirePermission), UI лишь скрывает кнопки.
 */
export interface RoleDefinition {
  id: BuiltinRoleId;
  name: string;
  description: string;
  sortOrder: number;
  permissions: Permission[];
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: "admin",
    name: "Администратор",
    description: "Полный доступ, управление пользователями и настройками",
    sortOrder: 10,
    permissions: [
      "journal.view",
      "journal.register",
      "journal.edit",
      "journal.archive",
      // Отмена закрытия года — изменение задним числом, и цена ошибки выше, чем у закрытия.
      // Поэтому есть у администратора и нет у аппарата: кто действует и кто отменяет — разные люди.
      "journal.reopen",
      "resolution.create",
      "resolution.edit",
      "resolution.approve",
      "resolution.dispatch",
      "task.view",
      "task.report",
      "users.manage",
      "settings.manage",
      "audit.view",
      "notifications.view"
    ]
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
      // Аппарат ведёт сроки и подтверждает отчёты — без центра уведомлений он их не увидит.
      "notifications.view"
    ]
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
    ]
  },
  {
    id: "executor",
    name: "Исполнитель",
    description: "Получение задач и отчёт об исполнении",
    sortOrder: 40,
    permissions: ["journal.view", "task.view", "task.report", "notifications.view"]
  },
  {
    id: "signer",
    name: "Подписант",
    description: "Утверждение резолюций (ген.дир или тот, кому он делегировал право подписи)",
    sortOrder: 50,
    // Уведомления нужны и подписанту: он видит, что поручение ушло и чем закончилось.
    permissions: ["journal.view", "resolution.approve", "task.view", "notifications.view"]
  }
];

const ROLE_BY_ID = new Map(ROLE_DEFINITIONS.map((r) => [r.id, r]));

/** Права, которые даёт набор ролей (объединение). */
export function permissionsOfRoles(roleIds: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const id of roleIds) {
    for (const p of ROLE_BY_ID.get(id as BuiltinRoleId)?.permissions ?? []) set.add(p);
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
  return ROLE_BY_ID.get(id as BuiltinRoleId)?.name ?? id;
}

/** Собирает AuthUser из записи пользователя и его ролей. */
export function buildAuthUser(user: Omit<UserWithRoles, "roles"> & { roles: string[] }): AuthUser {
  return { ...user, permissions: permissionsOfRoles(user.roles) };
}
