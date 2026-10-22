import { settingsTabKeys } from "../settingsTabs";
import type { Permission } from "../types";

/**
 * Права вкладок настроек — чистая логика, без jsdom и AntD.
 *
 * Раньше эти же проверки монтировали весь SettingsModal: пять тестов в одном файле
 * шли 100 секунд из-за накопления таймеров/порталов AntD. Здесь — миллисекунды.
 */
const can = (permissions: string[]) => (p: Permission) => permissions.includes(p);

describe("какие вкладки настроек видит роль", () => {
  it("без ролей: только личные разделы и справочники", () => {
    const keys = settingsTabKeys(can([]), true);

    expect(keys).toEqual(["general", "mail", "profile", "connection", "templates", "ldap"]);
  });

  it("users.manage открывает пользователей, роли и документооборот", () => {
    const keys = settingsTabKeys(can(["users.manage"]), true);

    expect(keys).toEqual(expect.arrayContaining(["users", "roles", "docflow"]));
    // Права на журнал нет — нумерация закрыта, если нет и settings.manage.
    expect(keys).not.toContain("numbering");
  });

  it("settings.manage открывает нумерацию, служебные ящики, сортировку, уведомления и ИИ", () => {
    const keys = settingsTabKeys(can(["settings.manage"]), true);

    expect(keys).toEqual(
      expect.arrayContaining(["numbering", "service", "sorting", "notifications", "ai"])
    );
  });

  it("journal.view открывает нумерацию на чтение", () => {
    expect(settingsTabKeys(can(["journal.view"]), true)).toContain("numbering");
  });

  it("audit.view открывает аудит", () => {
    expect(settingsTabKeys(can(["audit.view"]), true)).toContain("audit");
  });

  it("без своего ящика вкладки «Почта» нет", () => {
    expect(settingsTabKeys(can([]), false)).not.toContain("mail");
  });
});
