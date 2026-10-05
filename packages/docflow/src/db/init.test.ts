import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./index.js";

/**
 * Инициализация базы документооборота — промис-синглтон.
 *
 * Прежний код проверял «уже инициализировано?» и только потом создавал пул: два
 * параллельных вызова (сервер и фоновая задача, два запроса при старте) создавали
 * ДВА пула, первый оставался без ссылки и не закрывался — соединения утекали.
 * Тест считает сами создания pg.Pool: их обязан быть ровно один на все вызовы.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

// ⚠️ Тесты трогают таблицы, поэтому база обязана быть отдельной и тестовой.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error("Тесты работают только с тестовой базой, а не " + TEST_DB_URL);
}

let dir = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Подменяет pg.Pool, чтобы посчитать созданные пулы и закрытые из них. */
function countPools(): { created: number; ended: number; restore: () => void } {
  const pgAny = pg as any;
  const OriginalPool = pgAny.Pool;
  let created = 0;
  let ended = 0;
  class CountingPool extends OriginalPool {
    constructor(...args: any[]) {
      super(...args);
      created++;
    }
    end(...args: any[]) {
      ended++;
      return super.end(...args);
    }
  }
  pgAny.Pool = CountingPool;
  return {
    get created() {
      return created;
    },
    get ended() {
      return ended;
    },
    restore() {
      pgAny.Pool = OriginalPool;
    }
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-init-"));
  initCoreDb(dir);
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

describe("инициализация базы документооборота", () => {
  test("параллельные вызовы создают один пул и одну базу", async () => {
    const counter = countPools();
    try {
      const [a, b, c] = await Promise.all([
        initDocflowDb(TEST_DB_URL),
        initDocflowDb(TEST_DB_URL),
        initDocflowDb(TEST_DB_URL)
      ]);
      // Сравниваем булево: печать двух объектов drizzle при падении съедает гигабайты.
      expect(a === b && b === c).toBe(true);
      expect(counter.created).toBe(1);
      expect(getDocflowPool()).toBeTruthy();
    } finally {
      counter.restore();
      await closeDocflowDb();
    }
  });

  test("повторный вызов после инициализации не создаёт второй пул", async () => {
    const counter = countPools();
    try {
      const first = await initDocflowDb(TEST_DB_URL);
      const second = await initDocflowDb(TEST_DB_URL);
      expect(second === first).toBe(true);
      expect(counter.created).toBe(1);
    } finally {
      counter.restore();
      await closeDocflowDb();
    }
  });

  test("неудачная инициализация не отравляет синглтон: следующий вызов работает", async () => {
    const counter = countPools();
    try {
      await expect(initDocflowDb("postgres://mailsense:testpass@127.0.0.1:59999/nope")).rejects.toThrow();
      expect(counter.ended).toBeGreaterThanOrEqual(1); // неудачный пул закрыт, а не брошен
      const db = await initDocflowDb(TEST_DB_URL);
      // База действительно рабочая, а не «повисший» промис.
      const rows = await getDocflowPool().query("SELECT 1 AS ok");
      expect(rows.rows[0].ok).toBe(1);
    } finally {
      counter.restore();
      await closeDocflowDb();
    }
  });

  test("после закрытия базу можно поднять снова", async () => {
    const first = await initDocflowDb(TEST_DB_URL);
    await closeDocflowDb();
    const second = await initDocflowDb(TEST_DB_URL);
    expect(second === first).toBe(false);
    expect(getDocflowPool()).toBeTruthy();
    await closeDocflowDb();
  });
});
