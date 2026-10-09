import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { insertUser } from "./repo.js";
import { setServiceAccountId, SERVICE_ACCOUNT_SETTING } from "./serviceAccount.js";
import type { Actor } from "./journal.js";
import {
  EDMS_ALLOWED_WORK_ACCOUNTS_SETTING,
  EDMS_WORK_ACCOUNT_SETTING,
  EDMS_WORK_MAIL_ALLOWANCE_AUDIT_ACTION,
  getAllowedWorkAccounts,
  getUserSetting,
  parseAccountIdList,
  setAllowedWorkAccounts,
  setUserSetting
} from "./userSettings.js";

/**
 * Выдача работнику ящиков «почты для СЭД» (task-56).
 *
 * Закрываем дыру: без выдачи работник мог выбрать ЛЮБОЙ ящик сервера и отправлять
 * с него официальные письма. Главное свойство отзыва: ящик запретили — выбор,
 * который на него указывал, обязан сброситься, и всё это одной транзакцией.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const actor: Actor = { id: "u-admin", name: "Администратор" };
let dir = "";
let userId = "";

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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-edms-allowance-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
  await sql("TRUNCATE settings, audit_log, users, sessions, user_roles, user_settings RESTART IDENTITY CASCADE");
  userId = (await insertUser({ ldapUid: "petrova_ma", email: "petrova_ma@stand.test", fullName: "Петрова М.А.", source: "manual" }))
    .id;
});

afterAll(async () => {
  await sql("TRUNCATE settings, audit_log, users, sessions, user_roles, user_settings RESTART IDENTITY CASCADE");
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

describe("разбор списка выданных ящиков", () => {
  test("пусто, пробелы и дубликаты — чисто", () => {
    expect(parseAccountIdList(null)).toEqual([]);
    expect(parseAccountIdList("  ")).toEqual([]);
    expect(parseAccountIdList("acc-1, ,acc-2")).toEqual(["acc-1", "acc-2"]);
    expect(parseAccountIdList(" acc-1 , acc-1 ,acc-2")).toEqual(["acc-1", "acc-2"]);
  });
});

describe("выдача ящиков администратором", () => {
  test("выдача сохраняется и читается", async () => {
    const result = await setAllowedWorkAccounts(userId, ["acc-1", "acc-2"], actor);

    expect(result).toEqual({ accountIds: ["acc-1", "acc-2"], resetChoice: null });
    expect(await getAllowedWorkAccounts(userId)).toEqual(["acc-1", "acc-2"]);
  });

  test("дубликаты схлопываются, след аудита пишется в той же транзакции", async () => {
    await setAllowedWorkAccounts(userId, ["acc-1", " acc-1 ", "acc-2"], actor);

    expect(await getAllowedWorkAccounts(userId)).toEqual(["acc-1", "acc-2"]);
    const rows = await getDocflowPool().query<{ action: string; entity_id: string; old_value: string; new_value: string }>(
      "SELECT action, entity_id, old_value, new_value FROM audit_log WHERE action = $1",
      [EDMS_WORK_MAIL_ALLOWANCE_AUDIT_ACTION]
    );
    expect(rows.rows[0].entity_id).toBe(userId);
    expect(JSON.parse(rows.rows[0].old_value)).toEqual({ [EDMS_ALLOWED_WORK_ACCOUNTS_SETTING]: [] });
    expect(JSON.parse(rows.rows[0].new_value)).toEqual({ [EDMS_ALLOWED_WORK_ACCOUNTS_SETTING]: ["acc-1", "acc-2"] });
  });

  test("пустая выдача убирает строку настройки", async () => {
    await setAllowedWorkAccounts(userId, ["acc-1"], actor);
    await setAllowedWorkAccounts(userId, [], actor);

    expect(await getAllowedWorkAccounts(userId)).toEqual([]);
    expect(
      await count("SELECT count(*)::int AS n FROM user_settings WHERE key = $1", [EDMS_ALLOWED_WORK_ACCOUNTS_SETTING])
    ).toBe(0);
  });
});

describe("отзыв ящика сбрасывает выбор работника", () => {
  test("выбранный ящик отозван — выбор сброшен и есть след", async () => {
    await setAllowedWorkAccounts(userId, ["acc-1", "acc-2"], actor);
    await setUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, "edms.work_mail");

    const result = await setAllowedWorkAccounts(userId, ["acc-2"], actor);

    expect(result.resetChoice).toBe("acc-1");
    // Право отправлять с запрещённого ящика не осталось.
    expect(await getUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING)).toBeNull();
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'edms.work_mail' AND new_value LIKE '%null%'"
      )
    ).toBe(1);
  });

  test("выбранный ящик остался в списке — выбор не трогаем", async () => {
    await setAllowedWorkAccounts(userId, ["acc-1", "acc-2"], actor);
    await setUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, "edms.work_mail");

    const result = await setAllowedWorkAccounts(userId, ["acc-1"], actor);

    expect(result.resetChoice).toBeNull();
    expect(await getUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-1");
  });

  test("служебный ящик предприятия разрешён всегда — его отзыв выбора не касается", async () => {
    await sql(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [SERVICE_ACCOUNT_SETTING, "acc-service"]
    );
    await setUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING, "acc-service", actor, "edms.work_mail");
    await setAllowedWorkAccounts(userId, ["acc-1"], actor);

    const result = await setAllowedWorkAccounts(userId, [], actor);

    expect(result.resetChoice).toBeNull();
    expect(await getUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-service");
    await sql("DELETE FROM settings WHERE key = $1", [SERVICE_ACCOUNT_SETTING]);
  });

  test("сбой аудита откатывает И выдачу, И сброс выбора", async () => {
    await setAllowedWorkAccounts(userId, ["acc-1", "acc-2"], actor);
    await setUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING, "acc-1", actor, "edms.work_mail");
    await blockAudit();
    try {
      await expect(setAllowedWorkAccounts(userId, ["acc-2"], actor)).rejects.toThrow();
      expect(await getAllowedWorkAccounts(userId)).toEqual(["acc-1", "acc-2"]);
      expect(await getUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING)).toBe("acc-1");
    } finally {
      await unblockAudit();
    }
  });
});
