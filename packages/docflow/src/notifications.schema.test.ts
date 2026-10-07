import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { docflowMigrations, runDocflowMigrations } from "./db/migrate.js";
import { NOTIFICATION_KINDS } from "./notifications.js";

/**
 * Этап 5 (§2 контракта): миграция v7 — таблицы уведомлений, шаблонов и правил сортировки.
 *
 * Проверяем СХЕМУ в живой тестовой базе, а не наличие SQL в исходнике: индекс уникальности
 * dedupe-ключа — это то, на чём держится идемпотентность материализации сроков. Если он
 * пропадёт, каждое чтение будет плодить дубли напоминаний, и заметить это по коду нельзя.
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

let dir = "";

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(sql, params);
  return Number(rows.rows[0]?.n ?? 0);
}

/** Переигрывает миграцию v7 на текущей базе: проверяем свойство САМОЙ миграции. */
async function replayV7(): Promise<void> {
  await getDocflowPool().query("DELETE FROM docflow_migrations WHERE version = 7");
  await runDocflowMigrations(getDocflowPool());
}

const SHARED_TABLES =
  "notifications, notification_templates, mail_sort_rules, audit_log, resolution_assignees, " +
  "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
  "settings, sessions, user_roles, users RESTART IDENTITY CASCADE";

/**
 * Уборка за собой: база mailsense_test ОБЩАЯ для всех файлов прогона (rules §2.6, §3).
 * Файл, который что-то записал, обязан это убрать — иначе падение зависит от порядка файлов.
 */
async function cleanupSharedDb(): Promise<void> {
  await getDocflowPool().query("TRUNCATE " + SHARED_TABLES);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-notif-schema-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
  // Миграция v7 на уже мигрированной базе не переигрывается, а её сид-данные нужны тесту:
  // переигрываем принудительно — от того, какой файл выполнялся перед нами, ничего не зависит.
  await replayV7();
});

afterAll(async () => {
  await cleanupSharedDb();
  // Уборка проверяется явно: снимешь TRUNCATE — упадёт здесь, а не в чужом файле.
  expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
  expect(await count("SELECT count(*)::int AS n FROM settings")).toBe(0);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("миграция v7: таблицы этапа 5", () => {
  test("свободный номер — 7, и он последний", () => {
    expect(Math.max(...docflowMigrations.map((m) => m.version))).toBe(7);
  });

  test("все три таблицы существуют", async () => {
    const rows = await getDocflowPool().query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN " +
        "('notifications','notification_templates','mail_sort_rules') ORDER BY tablename"
    );
    expect(rows.rows.map((r) => r.tablename)).toEqual([
      "mail_sort_rules",
      "notification_templates",
      "notifications"
    ]);
  });

  test("dedupe-ключ уникален в пределах пользователя", async () => {
    const idx = await getDocflowPool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'notifications_dedupe_idx'"
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(idx.rows[0].indexdef).toMatch(/user_id/);
    expect(idx.rows[0].indexdef).toMatch(/dedupe_key/);
  });

  test("индекс непрочитанных — частичный: иначе он рос бы вместе с прочитанными", async () => {
    const idx = await getDocflowPool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'notifications_unread_idx'"
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/WHERE/i);
    expect(idx.rows[0].indexdef).toMatch(/read_at IS NULL/i);
  });

  test("уведомление без пользователя не заводится: FK на users", async () => {
    await expect(
      getDocflowPool().query(
        "INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, title, body, severity, dedupe_key) " +
          "VALUES ('n-fk', 'нет-такого', 'resolution.assigned', 'resolution', 'r-1', 'т', '', 'info', 'k')"
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  test("миграция сеет шаблон для КАЖДОГО вида уведомления", async () => {
    // Проверяем свойство миграции, а не «в базе так сложилось»: чистим таблицу и переигрываем v7.
    await getDocflowPool().query("TRUNCATE notification_templates");
    await replayV7();

    const rows = await getDocflowPool().query<{ key: string }>(
      "SELECT key FROM notification_templates ORDER BY key"
    );
    expect(rows.rows.map((r) => r.key)).toEqual([...NOTIFICATION_KINDS].sort());
  });

  test("дефолтных правил сортировки НЕТ: пустой список честнее выдуманного правила", async () => {
    // ⚠️ Раньше тест требовал пустую таблицу ЦЕЛИКОМ и краснел от порядка файлов прогона
    // (sortingRules оставлял своё правило). Теперь проверяется свойство миграции:
    // выдуманных правил в v7 нет — после чистой таблицы и переигровки их по-прежнему нет.
    await getDocflowPool().query("TRUNCATE mail_sort_rules");
    await replayV7();
    expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
  });

  test("повторный прогон миграции v7 не дублирует шаблоны и не падает", async () => {
    const before = await count("SELECT count(*)::int AS n FROM notification_templates");
    await getDocflowPool().query("DELETE FROM docflow_migrations WHERE version = 7");
    await runDocflowMigrations(getDocflowPool());
    const after = await count("SELECT count(*)::int AS n FROM notification_templates");
    expect(after).toBe(before);
    expect(after).toBe(NOTIFICATION_KINDS.length);
  });
});
