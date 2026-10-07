import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

/**
 * Миграции локальной SQLite.
 *
 * Черновик в тонком клиенте падал с «FOREIGN KEY constraint failed»: локальная drafts
 * ссылалась на локальную accounts, а в клиентском режиме ящиков в локальной базе нет
 * (/api/accounts проксируется на сервер). SQLite не умеет DROP CONSTRAINT, поэтому
 * таблица пересоздаётся с переносом строк.
 */

/** Версия миграции, которая убирает FK у черновиков. */
const DRAFTS_FK_VERSION = 13;

/** Состояние таблицы ДО этой миграции — ровно так она выглядела в бою (миграция v7). */
const OLD_DRAFTS_DDL = `
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  "to" TEXT NOT NULL DEFAULT '[]',
  cc TEXT NOT NULL DEFAULT '[]',
  bcc TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  in_reply_to_email_id TEXT,
  in_reply_to_message_id TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_account_idx ON drafts(account_id);
`;

function fkTargets(db: Database.Database): string[] {
  const rows = db.prepare("PRAGMA foreign_key_list(drafts)").all() as Array<{ table: string }>;
  return rows.map((r) => r.table);
}

function tmpDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-migrate-"));
  const db = new Database(path.join(dir, "mailsense.sqlite"));
  db.pragma("foreign_keys = ON"); // как в боевом db/index.ts
  return { db, dir };
}

function insertLocalAccount(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO accounts (id, protocol, host, port, tls, username, password_encrypted, created_at, updated_at) " +
      "VALUES (?, 'imap', 'mail.test', 993, 'ssl', 'u@mail.test', 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
  ).run(id);
}

function insertDraftRow(db: Database.Database, id: string, accountId: string, subject: string): void {
  db.prepare(
    "INSERT INTO drafts (id, account_id, subject, body_text, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, accountId, subject, "тело", '[]', "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

describe("миграция черновиков без внешнего ключа", () => {
  test("свежая база: у account_id черновика нет FK", () => {
    const { db, dir } = tmpDb();
    try {
      runMigrations(db);
      expect(fkTargets(db)).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("таблица «виденных вне диапазона» создана и ссылается на ящик", () => {
    const { db, dir } = tmpDb();
    try {
      runMigrations(db);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name
      );
      expect(tables).toContain("out_of_range_emails");
      // Строка обязана быть привязана к существующему ящику: иначе «виденное» переживёт ящик.
      insertLocalAccount(db, "acc-1");
      expect(() =>
        db
          .prepare("INSERT INTO out_of_range_emails (account_id, folder, uid, server_date, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("acc-1", "INBOX", "uid-1", "2024-01-01T10:00:00.000Z", "2026-01-01T00:00:00.000Z")
      ).not.toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO out_of_range_emails (account_id, folder, uid, server_date, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("нет-такого", "INBOX", "uid-2", null, "2026-01-01T00:00:00.000Z")
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("повторный прогон миграций идемпотентен", () => {
    const { db, dir } = tmpDb();
    try {
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();
      expect(fkTargets(db)).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("существующая база: черновики переживают пересоздание таблицы", () => {
    const { db, dir } = tmpDb();
    try {
      runMigrations(db);

      // Воспроизводим базу «до»: таблица со старым FK и живой строкой.
      db.exec("DROP TABLE drafts;");
      db.exec(OLD_DRAFTS_DDL);
      insertLocalAccount(db, "acc-1");
      insertDraftRow(db, "draft-1", "acc-1", "Старый черновик");
      // и снимаем отметку о применении миграции — как на базе, до которой правка не доехала
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(DRAFTS_FK_VERSION);

      runMigrations(db);

      const row = db.prepare("SELECT account_id, subject, body_text FROM drafts WHERE id = ?").get("draft-1") as
        | { account_id: string; subject: string; body_text: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.account_id).toBe("acc-1");
      expect(row!.subject).toBe("Старый черновик");
      expect(row!.body_text).toBe("тело");
      expect(fkTargets(db)).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("в клиентском режиме черновик создаётся при ящике, которого нет в accounts", () => {
    const { db, dir } = tmpDb();
    try {
      runMigrations(db);
      // Локальных ящиков нет вообще — id принадлежит серверу.
      expect((db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number }).c).toBe(0);

      expect(() => insertDraftRow(db, "draft-server", "server-account-1", "Черновик клиента")).not.toThrow();
      expect((db.prepare("SELECT COUNT(*) AS c FROM drafts").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
