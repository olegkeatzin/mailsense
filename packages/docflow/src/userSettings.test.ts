import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { insertUser } from "./repo.js";
import type { Actor } from "./journal.js";
import {
  EDMS_WORK_ACCOUNT_SETTING,
  EDMS_WORK_MAIL_AUDIT_ACTION,
  getUserSetting,
  listUserSettings,
  setUserSetting
} from "./userSettings.js";

/**
 * Личные настройки работника в СЭД (Р24, task-51): «почта для СЭД».
 *
 * Проверяем два свойства, ради которых это не «ещё один setSetting»:
 *   • выбор ЛИЧНЫЙ: чужая настройка не видна;
 *   • смена и след аудита — одна транзакция (AGENTS.md, п. 4): от выбора зависит,
 *     с какого адреса уйдёт официальное письмо, и след не должен теряться.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const actor: Actor = { id: "u-admin", name: "Администратор" };
let dir = "";
let userA = "";
let userB = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

async function blockAudit(): Promise<void> {
  await sql(
    "CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger AS $$ " +
      "BEGIN RAISE EXCEPTION 'тест: запись аудита недоступна'; END; $$ LANGUAGE plpgsql; " +
      "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; " +
      "CREATE TRIGGER test_block_audit_trg BEFORE INSERT ON audit_log " +
      "FOR EACH ROW EXECUTE FUNCTION test_block_audit();"
  );
}

async function unblockAudit(): Promise<void> {
  await sql("DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; DROP FUNCTION IF EXISTS test_block_audit();");
}

async function cleanupSharedDb(): Promise<void> {
  await sql("TRUNCATE settings, audit_log, users, sessions, user_roles, user_settings RESTART IDENTITY CASCADE");
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-user-settings-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
  await cleanupSharedDb();
  userA = (await insertUser({ ldapUid: "user-a", email: "a@stand.test", fullName: "Работник А", source: "manual" })).id;
  userB = (await insertUser({ ldapUid: "user-b", email: "b@stand.test", fullName: "Работник Б", source: "manual" })).id;
});

afterAll(async () => {
  await cleanupSharedDb();
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await sql("DELETE FROM user_settings");
  await sql("DELETE FROM audit_log");
});

describe("выбор «почты для СЭД» сохраняется и читается", () => {
  test("значение записывается и отдаётся обратно", async () => {
    const saved = await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    expect(saved).toBe("acc-1");
    expect(await getUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-1");
    expect(await listUserSettings(userA)).toEqual({ [EDMS_WORK_ACCOUNT_SETTING]: "acc-1" });
  });

  test("повторная запись обновляет значение", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-2", actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    expect(await getUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-2");
    expect(await count("SELECT count(*)::int AS n FROM user_settings WHERE user_id = $1", [userA])).toBe(1);
  });

  test("снятие выбора (null) убирает строку", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);
    const cleared = await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, null, actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    expect(cleared).toBeNull();
    expect(await getUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING)).toBeNull();
    expect(await count("SELECT count(*)::int AS n FROM user_settings WHERE user_id = $1", [userA])).toBe(0);
  });

  test("выбор одного работника не виден другому", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    expect(await getUserSetting(userB, EDMS_WORK_ACCOUNT_SETTING)).toBeNull();
    expect(await listUserSettings(userB)).toEqual({});
  });

  test("пустой идентификатор работника не создаёт настройку", async () => {
    expect(await getUserSetting("", EDMS_WORK_ACCOUNT_SETTING)).toBeNull();
    await expect(setUserSetting("", EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION)).rejects.toThrow(
      /работник/i
    );
  });
});

describe("след аудита пишется вместе с настройкой", () => {
  test("было пусто → стало ящик, в entity_id — работник", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    const rows = await getDocflowPool().query<{
      action: string;
      entity_type: string;
      entity_id: string;
      old_value: string;
      new_value: string;
      user_name: string;
    }>("SELECT action, entity_type, entity_id, old_value, new_value, user_name FROM audit_log ORDER BY created_at DESC LIMIT 1");

    expect(rows.rows[0]).toMatchObject({
      action: EDMS_WORK_MAIL_AUDIT_ACTION,
      entity_type: "user",
      entity_id: userA,
      user_name: "Администратор"
    });
    expect(JSON.parse(rows.rows[0].old_value)).toEqual({ [EDMS_WORK_ACCOUNT_SETTING]: null });
    expect(JSON.parse(rows.rows[0].new_value)).toEqual({ [EDMS_WORK_ACCOUNT_SETTING]: "acc-1" });
  });

  test("смена и снятие оставляют по следу", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-2", actor, EDMS_WORK_MAIL_AUDIT_ACTION);
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, null, actor, EDMS_WORK_MAIL_AUDIT_ACTION);

    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = $1", [EDMS_WORK_MAIL_AUDIT_ACTION])).toBe(3);
  });

  test("сбой аудита откатывает настройку", async () => {
    await setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, EDMS_WORK_MAIL_AUDIT_ACTION);
    await blockAudit();
    try {
      await expect(
        setUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING, "acc-3", actor, EDMS_WORK_MAIL_AUDIT_ACTION)
      ).rejects.toThrow();
      // Настройка осталась прежней: изменение без следа недопустимо.
      expect(await getUserSetting(userA, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-1");
    } finally {
      await unblockAudit();
    }
  });
});
