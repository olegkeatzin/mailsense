import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import type { Actor } from "./journal.js";
import {
  SERVICE_ACCOUNT_SETTING,
  getServiceAccountId,
  getServiceAccountState,
  setServiceAccountId
} from "./serviceAccount.js";

/**
 * Служебный ящик отправки (Р12, task-11): настройка docflow.serviceAccountId.
 *
 * Почему это не «ещё один setSetting»: смена служебного ящика меняет, ОТ ЧЬЕГО ИМЕНИ уходят
 * официальные письма. Такой след обязан остаться, и писаться он должен в той же транзакции,
 * что и сама настройка (AGENTS.md, п. 4) — иначе «кто переключил отправку» не найти.
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

/** Уборка за собой: база общая с другими файлами прогона (rules §2.6, §3). */
async function cleanupSharedDb(): Promise<void> {
  await sql("TRUNCATE settings, audit_log, users, sessions, user_roles RESTART IDENTITY CASCADE");
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-service-account-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await unblockAudit().catch(() => undefined);
  await cleanupSharedDb();
  // Проверка, что уборка сделана: снимешь TRUNCATE — падает здесь, а не в чужом файле.
  expect(await count("SELECT count(*)::int AS n FROM settings")).toBe(0);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await unblockAudit();
  await sql("TRUNCATE settings, audit_log, users, sessions, user_roles RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  await unblockAudit();
});

describe("выбор служебного ящика", () => {
  test("по умолчанию ящик не задан", async () => {
    expect(await getServiceAccountId()).toBeNull();
  });

  test("выбор сохраняется и читается", async () => {
    expect(await setServiceAccountId("acc-test", actor)).toBe("acc-test");
    expect(await getServiceAccountId()).toBe("acc-test");
  });

  test("снятие выбора остаётся ЗАПИСЬЮ: «настроено и снято» не путается с «не задано»", async () => {
    expect(await getServiceAccountState()).toEqual({ explicit: false, accountId: null });

    await setServiceAccountId("acc-test", actor);
    expect(await getServiceAccountState()).toEqual({ explicit: true, accountId: "acc-test" });

    expect(await setServiceAccountId(null, actor)).toBeNull();
    expect(await getServiceAccountId()).toBeNull();
    // Строка с пустым значением ОСТАЁТСЯ — это отметка «администратор снял выбор»,
    // и она перебивает старое место настроек (иначе отправка ушла бы с чужого ящика).
    expect(await getServiceAccountState()).toEqual({ explicit: true, accountId: null });
    expect(await count("SELECT count(*)::int AS n FROM settings WHERE key = $1", [SERVICE_ACCOUNT_SETTING])).toBe(1);

    await setServiceAccountId("acc-2", actor);
    expect(await setServiceAccountId("   ", actor)).toBeNull();
    expect(await getServiceAccountState()).toEqual({ explicit: true, accountId: null });
  });
});

describe("смена служебного ящика и её след — одна операция", () => {
  test("выбор пишется в аудит: было null, стало ящик", async () => {
    await setServiceAccountId("acc-test", actor);

    const rows = await getDocflowPool().query<{
      action: string;
      entity_type: string;
      entity_id: string;
      old_value: string;
      new_value: string;
      user_name: string;
    }>("SELECT action, entity_type, entity_id, old_value, new_value, user_name FROM audit_log");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: "docflow.service_account",
      entity_type: "settings",
      entity_id: SERVICE_ACCOUNT_SETTING
    });
    expect(rows.rows[0].old_value).toContain("null");
    expect(rows.rows[0].new_value).toContain("acc-test");
  });

  test("переключение с одного ящика на другой видно в следе", async () => {
    await setServiceAccountId("acc-1", actor);
    await setServiceAccountId("acc-2", actor);

    const rows = await getDocflowPool().query<{ old_value: string; new_value: string }>(
      "SELECT old_value, new_value FROM audit_log WHERE action = 'docflow.service_account' ORDER BY created_at"
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1].old_value).toContain("acc-1");
    expect(rows.rows[1].new_value).toContain("acc-2");
  });

  test("снятие выбора тоже оставляет след", async () => {
    await setServiceAccountId("acc-test", actor);
    await setServiceAccountId(null, actor);

    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'docflow.service_account'")).toBe(2);
  });

  test("сбой записи аудита откатывает смену ящика", async () => {
    await setServiceAccountId("acc-old", actor);
    await blockAudit();

    await expect(setServiceAccountId("acc-new", actor)).rejects.toThrow();

    // Настройка осталась прежней: изменение без следа невозможно.
    expect(await getServiceAccountId()).toBe("acc-old");
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'docflow.service_account'")).toBe(1);
  });
});
