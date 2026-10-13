import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { schema } from "./schema.js";
import { runMigrations } from "./migrate.js";

export type Db = BetterSQLite3Database<typeof schema>;

let db: Db | null = null;
let sqlite: Database.Database | null = null;

/**
 * Объясняет отказ открыть базу человеческими словами.
 *
 * Найдено на развёртывании: если папки данных на хосте не было до первого запуска, Docker создаёт
 * её от root. Приложение в контейнере работает от непривилегированного пользователя node (UID 1000)
 * и не может туда писать — падает с голым «SqliteError: unable to open database file», по которому
 * непонятно, что делать. Здесь причина и команда называются прямо.
 *
 * Чистая функция: проверяется тестом без базы и файловой системы.
 */
export function explainDbOpenError(err: unknown, dataDir: string, filename: string): Error {
  const message = String((err as Error)?.message ?? err);
  const dbPath = path.join(dataDir, filename);
  const cannotOpen = /SQLITE_CANTOPEN|unable to open database file|EACCES|EPERM|permission denied/i.test(message);
  if (!cannotOpen) return err instanceof Error ? err : new Error(message);
  return new Error(
    "Не удалось открыть базу данных: " +
      dbPath +
      "\nКаталог данных недоступен для записи. Если приложение работает в контейнере, оно запускается " +
      "от пользователя node (UID 1000), а папка на хосте, скорее всего, принадлежит root — так Docker " +
      "создаёт её, если до первого запуска папки не было.\n" +
      "Что сделать: `ls -ld " +
      dataDir +
      "` — и, если владелец root, `sudo chown -R 1000:1000 " +
      dataDir +
      "`, после чего перезапустить. Надёжнее создавать папки заранее: `mkdir -p data pgdata`."
  );
}

export function initDb(dataDir: string, filename = "mailsense.sqlite"): Db {
  if (db) return db;
  const dbPath = path.join(dataDir, filename);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    sqlite = new Database(dbPath);
  } catch (err) {
    throw explainDbOpenError(err, dataDir, filename);
  }
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
