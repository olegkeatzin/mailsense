import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { docflowSchema } from "./schema.js";
import { runDocflowMigrations } from "./migrate.js";

export type DocflowDb = NodePgDatabase<typeof docflowSchema>;

let db: DocflowDb | null = null;
let pool: pg.Pool | null = null;
/**
 * Незавершённая инициализация. Прежний код проверял только наличие db, а между проверкой
 * и присваиванием стояли два await: два параллельных вызова создавали ДВА пула,
 * первый терял ссылку и не закрывался — соединения утекали до перезапуска.
 */
let starting: Promise<DocflowDb> | null = null;

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
  // Параллельный вызов ждёт ту же инициализацию, а не создаёт второй пул.
  if (starting) return starting;

  const url = connectionString ?? docflowDatabaseUrl();
  if (!url) {
    throw new Error(
      "Не задан адрес базы документооборота. Укажите " +
        DOCFLOW_DB_ENV +
        " (например, postgres://user:pass@host:5432/mailsense)"
    );
  }

  // Присваиваем синхронно, до первого await: иначе гонка остаётся.
  starting = (async () => {
    const created = new pg.Pool({ connectionString: url, max: 10 });
    pool = created;
    // Падаем сразу и с понятным текстом, а не на первом запросе пользователя.
    await created.query("SELECT 1");
    await runDocflowMigrations(created);
    db = drizzle(created, { schema: docflowSchema });
    return db;
  })();

  try {
    return await starting;
  } catch (err) {
    // Неудачную попытку не кэшируем: следующий вызов обязан попробовать снова,
    // иначе одна сетевая ошибка на старте навсегда выключала бы документооборот.
    starting = null;
    const failed = pool;
    pool = null;
    db = null;
    await failed?.end().catch(() => undefined);
    throw err;
  }
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
  // Если инициализация ещё идёт — дожидаемся её, чтобы не закрывать пул «из-под неё».
  const inFlight = starting;
  starting = null;
  if (inFlight) await inFlight.catch(() => undefined);
  const closing = pool;
  pool = null;
  db = null;
  await closing?.end();
}

export { docflowSchema };
