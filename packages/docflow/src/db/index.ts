import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { docflowSchema } from "./schema.js";
import { runDocflowMigrations } from "./migrate.js";

export type DocflowDb = NodePgDatabase<typeof docflowSchema>;

let db: DocflowDb | null = null;
let pool: pg.Pool | null = null;

/**
 * Переменная окружения с адресом базы документооборота.
 * Локальная почта клиента при этом остаётся на SQLite — базы разные.
 */
export const DOCFLOW_DB_ENV = "DOCFLOW_DATABASE_URL";

export function docflowDatabaseUrl(): string | null {
  return (process.env[DOCFLOW_DB_ENV] ?? "").trim() || null;
}

export async function initDocflowDb(connectionString?: string): Promise<DocflowDb> {
  if (db) return db;
  const url = connectionString ?? docflowDatabaseUrl();
  if (!url) {
    throw new Error(
      "Не задан адрес базы документооборота. Укажите " +
        DOCFLOW_DB_ENV +
        " (например, postgres://user:pass@host:5432/mailsense)"
    );
  }
  pool = new pg.Pool({ connectionString: url, max: 10 });
  // Падаем сразу и с понятным текстом, а не на первом запросе пользователя.
  await pool.query("SELECT 1");
  await runDocflowMigrations(pool);
  db = drizzle(pool, { schema: docflowSchema });
  return db;
}

/**
 * Пул соединений — нужен там, где требуется транзакция (атомарная нумерация
 * документов): выдать номер и вставить запись журнала нужно одной операцией.
 */
export function getDocflowPool(): pg.Pool {
  if (!pool) throw new Error("База документооборота не инициализирована");
  return pool;
}

export function getDocflowDb(): DocflowDb {
  if (!db) throw new Error("База документооборота не инициализирована");
  return db;
}

/**
 * Инициализирована ли база. Нужна, чтобы отличить «документооборот не настроен»
 * (работаем как почтовый клиент) от «настроен, но недоступен» (это уже ошибка).
 */
export function hasDocflowDb(): boolean {
  return db !== null;
}

export async function closeDocflowDb(): Promise<void> {
  await pool?.end();
  pool = null;
  db = null;
}

export { docflowSchema };
