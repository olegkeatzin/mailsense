/**
 * Узкая точка входа для серверной части: каталог и логирование.
 *
 * Документообороту не нужна почта, вложения и ИИ — только LDAP (вход и синхронизация
 * сотрудников) и логгер. Импорт общего барреля `@mailsense/core` тянул бы в процесс
 * весь почтовый клиент вместе с очередями, поэтому здесь явный список.
 */
export type { LdapProfile } from "../types.js";
export { logger } from "../logger.js";
export * from "./ldap.js";
export * from "../services/directoryService.js";
export * from "../services/ldapSettingsStore.js";
