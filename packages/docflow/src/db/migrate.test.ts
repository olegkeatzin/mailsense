import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "../db/index.js";
import { docflowMigrations, runDocflowMigrations } from "../db/migrate.js";

/**
 * Миграции обязаны быть идемпотентными.
 *
 * ⚠️ На живой базе это не теория: колонки могли появиться раньше самой миграции
 * (руками или прерванным прогоном), и тогда повторный прогон ALTER TABLE ... ADD COLUMN
 * падает и останавливает старт сервера. Номер новой миграции сверен с docflow_migrations
 * живой базы (там 1..5, свободен 6).
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-migrate-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("идемпотентность миграций", () => {
  test("повторный прогон всех миграций на мигрированной базе не падает", async () => {
    const pool = getDocflowPool();
    // Снимаем отметки о применении: миграции обязаны пережить повторный прогон.
    await pool.query("DELETE FROM docflow_migrations");
    await expect(runDocflowMigrations(pool)).resolves.toBeUndefined();
    const rows = await pool.query<{ version: number }>("SELECT version FROM docflow_migrations ORDER BY version");
    expect(rows.rows.map((r) => r.version)).toEqual(docflowMigrations.map((m) => m.version));
  });

  test("номера миграций уникальны и идут подряд", () => {
    const versions = docflowMigrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  test("уникальность email включена частичным индексом", async () => {
    const pool = getDocflowPool();
    const idx = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_email_uniq_idx'"
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(idx.rows[0].indexdef).toMatch(/lower\(email\)/i);
    // Частичный: пустые адреса не считаются дублями.
    expect(idx.rows[0].indexdef).toMatch(/WHERE/i);
  });

  test("дубли email не проглатываются: миграция объясняет, что чинить", async () => {
    const pool = getDocflowPool();
    const ts = new Date().toISOString();
    await pool.query("DROP INDEX IF EXISTS users_email_uniq_idx");
    await pool.query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES " +
        "($1,$2,$3,$4,$5), ($6,$2,$7,$4,$5)",
      ["dup-1", "dup@example.com", "Дубль 1", ts, ts, "dup-2", "Дубль 2"]
    );
    try {
      await pool.query("DELETE FROM docflow_migrations WHERE version = $1", [6]);
      await expect(runDocflowMigrations(pool)).rejects.toThrow(/дубли.*dup@example\.com|dup@example\.com/);
    } finally {
      await pool.query("DELETE FROM users WHERE id IN ('dup-1','dup-2')");
      await pool.query("DELETE FROM docflow_migrations WHERE version = $1", [6]);
      await runDocflowMigrations(pool);
    }
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'users_email_uniq_idx'");
    expect(idx.rows).toHaveLength(1);
  });
});
