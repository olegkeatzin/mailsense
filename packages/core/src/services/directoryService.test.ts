import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, like } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { setSetting } from "../repos.js";
import { setLdapSettingsStore, type LdapSettingsStore } from "./ldapSettingsStore.js";
import {
  directoryCredentials,
  directoryStatus,
  getLdapSettings,
  setLdapSettings
} from "./directoryService.js";

/**
 * Каталог — инфраструктура предприятия. Когда рядом работает серверная часть,
 * владельцем настроек становится она, и локальные значения не должны просачиваться:
 * иначе ненастроенный каталог выглядел бы настроенным и указывал на чужой хост.
 */
let dir = "";

function localSetting(key: string): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : null;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-ldap-store-"));
  initDb(dir);
});

afterAll(() => {
  setLdapSettingsStore(null);
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setLdapSettingsStore(null);
  getDb().delete(settings).where(like(settings.key, "ldap.%")).run();
});

describe("локальное хранилище (автономный почтовый клиент)", () => {
  test("без настроек подставляются адреса предприятия как подсказка", () => {
    const s = getLdapSettings();
    expect(s.url).toBe("ldaps://srv-dc40.asup.local:636");
    expect(s.baseDn).toBe("DC=asup,DC=local");
  });

  test("сохранённые настройки читаются из локальной базы", async () => {
    await setLdapSettings({ url: "ldaps://dc.test:636", baseDn: "OU=K,DC=test" });
    const s = getLdapSettings();
    expect(s.url).toBe("ldaps://dc.test:636");
    expect(s.baseDn).toBe("OU=K,DC=test");
    expect(localSetting("ldap.url")).toBe("ldaps://dc.test:636");
  });
});

describe("внешнее хранилище (серверная часть владеет настройками)", () => {
  function store(initial: Record<string, string>): { store: LdapSettingsStore; written: Record<string, string> } {
    const written: Record<string, string> = {};
    let cache = { ...initial };
    return {
      written,
      store: {
        read: () => cache,
        write: async (values) => {
          Object.assign(written, values);
          cache = { ...cache, ...values };
        }
      }
    };
  }

  test("значения берутся из внешнего хранилища, а не из локальной базы", async () => {
    await setSetting("ldap.url", "ldaps://local.test:636"); // локальное значение — приманка
    const h = store({ "ldap.url": "ldaps://server.test:636", "ldap.baseDn": "OU=S,DC=test" });
    setLdapSettingsStore(h.store);

    const s = getLdapSettings();
    expect(s.url).toBe("ldaps://server.test:636");
    expect(s.baseDn).toBe("OU=S,DC=test");
  });

  test("пустое внешнее хранилище НЕ подставляет адреса предприятия", () => {
    const h = store({});
    setLdapSettingsStore(h.store);

    const s = getLdapSettings();
    // Иначе ненастроенный каталог выглядел бы настроенным и указывал на чужой хост.
    expect(s.url).toBe("");
    expect(s.baseDn).toBe("");
    expect(s.upnSuffix).toBe("");
    expect(s.netbiosDomain).toBe("");
  });

  test("запись уходит во внешнее хранилище и не трогает локальную базу", async () => {
    const h = store({});
    setLdapSettingsStore(h.store);

    await setLdapSettings({ url: "ldaps://new.test:636", baseDn: "OU=N,DC=test" });

    expect(h.written["ldap.url"]).toBe("ldaps://new.test:636");
    expect(h.written["ldap.baseDn"]).toBe("OU=N,DC=test");
    expect(localSetting("ldap.url")).toBeNull();
  });

  test("логин сервисной учётки тоже живёт во внешнем хранилище", () => {
    const h = store({ "ldap.login": "svc@test", "ldap.passwordEncrypted": "enc" });
    setLdapSettingsStore(h.store);

    const st = directoryStatus();
    expect(st.loggedIn).toBe(true);
    expect(st.login).toBe("svc@test");
  });

  test("directoryCredentials не отдаёт пароль, если он не расшифровывается", () => {
    const h = store({ "ldap.login": "svc@test", "ldap.passwordEncrypted": "не-шифртекст" });
    setLdapSettingsStore(h.store);
    expect(directoryCredentials()).toBeNull();
  });

  test("снятие внешнего хранилища возвращает локальные настройки", async () => {
    await setSetting("ldap.url", "ldaps://local.test:636");
    const h = store({ "ldap.url": "ldaps://server.test:636" });
    setLdapSettingsStore(h.store);
    expect(getLdapSettings().url).toBe("ldaps://server.test:636");

    setLdapSettingsStore(null);
    expect(getLdapSettings().url).toBe("ldaps://local.test:636");
  });
});
