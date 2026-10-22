import type { Permission } from "./types";

/**
 * Какие вкладки настроек видит роль.
 *
 * ⚠️ Чистая функция, а не проверка внутри JSX: именно её проверяют тесты прав.
 * Раньше права вкладок приходилось проверять, монтируя весь SettingsModal в jsdom —
 * AntD-табы и формы оставляли глобальные таймеры, и файл из пяти тестов шёл 100 секунд.
 *
 * Правило то же, что у маршрутов: каждая вкладка — по своему праву.
 * «Нумерация» — исключение: читать её может и настройщик без журнала (PUT и так закрыт
 * settings.manage), поэтому условие «journal.view ИЛИ settings.manage».
 */
export function settingsTabKeys(can: (permission: Permission) => boolean, canUseMail: boolean): string[] {
  return [
    "general",
    ...(canUseMail ? ["mail"] : []),
    "profile",
    "connection",
    ...(can("users.manage") ? ["users", "roles", "docflow"] : []),
    ...(can("journal.view") || can("settings.manage") ? ["numbering"] : []),
    ...(can("audit.view") ? ["audit"] : []),
    ...(can("settings.manage") ? ["service", "sorting", "notifications", "ai"] : []),
    "templates",
    "ldap"
  ];
}
