import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { getLdapSettings, setLdapSettingsStore } from "@mailsense/core/directory";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowDb, initDocflowDb } from "./db/index.js";
import { getSetting, setSetting } from "./settings.js";
import { installLdapSettingsStore } from "./ldapStore.js";

/**
 * Каталог принадлежит предприятию: настройки лежат в базе сервера и наполняются
 * только действием администратора. Локальный файл в базу предприятия не подмешивается.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";


// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
// Раньше здесь был фолбэк на DOCFLOW_DATABASE_URL — рабочую переменную стенда: один
// `make test` на машине с ней вычищал пользователей, сессии, настройки и append-only аудит.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-ldapstore-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  setLdapSettingsStore(null);
  await closeDocflowDb();
  closeCoreDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await getDocflowDb().execute(sql`DELETE FROM settings WHERE key LIKE 'ldap.%'`);
});

describe("настройки каталога в базе сервера", () => {
  test("пустая база: каталог считается ненастроенным, подсказок продакшена нет", async () => {
    await installLdapSettingsStore();
    const s = getLdapSettings();
    // Главное: адрес продакшена не должен «спасать» ненастроенный каталог.
    expect(s.url).toBe("");
    expect(s.baseDn).toBe("");
  });

  test("настройки, заданные администратором, читаются из базы сервера", async () => {
    await setSetting("ldap.url", "ldaps://dc.enterprise.test:636");
    await setSetting("ldap.baseDn", "OU=Company,DC=enterprise,DC=test");
    await setSetting("ldap.upnSuffix", "@enterprise.test");
    await installLdapSettingsStore();

    const s = getLdapSettings();
    expect(s.url).toBe("ldaps://dc.enterprise.test:636");
    expect(s.baseDn).toBe("OU=Company,DC=enterprise,DC=test");
    expect(s.upnSuffix).toBe("@enterprise.test");
  });

  test("локальная база в настройки предприятия не подмешивается", async () => {
    // Приманка в локальной (клиентской) базе: притворяемся, что кто-то правил её руками.
    const { setSetting: setLocalSetting } = await import("../../core/src/repos.js");
    setLocalSetting("ldap.url", "ldaps://rogue.test:636");
    await installLdapSettingsStore();

    expect(getLdapSettings().url).toBe("");
    expect(await getSetting("ldap.url")).toBeNull();
  });

  test("запись из интерфейса администратора уходит в базу сервера", async () => {
    await installLdapSettingsStore();
    const { setLdapSettings } = await import("@mailsense/core/directory");
    await setLdapSettings({ url: "ldaps://new-dc.test:636", baseDn: "OU=N,DC=test" });

    expect(await getSetting("ldap.url")).toBe("ldaps://new-dc.test:636");
    expect(getLdapSettings().url).toBe("ldaps://new-dc.test:636");
  });
});
