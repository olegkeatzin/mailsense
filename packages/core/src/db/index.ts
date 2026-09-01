import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { schema } from "./schema.js";
import { runMigrations } from "./migrate.js";

export type Db = BetterSQLite3Database<typeof schema>;

let db: Db | null = null;
let sqlite: Database.Database | null = null;

export function initDb(dataDir: string, filename = "mailsense.sqlite"): Db {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, filename);
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  db = drizzle(sqlite, { schema });
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("БД не инициализирована");
  return db;
}

export function closeDb(): void {
  sqlite?.close();
  db = null;
  sqlite = null;
}

export { schema };
