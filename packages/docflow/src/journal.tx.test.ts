import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";

/**
 * Регистрация документа — ручная транзакция на одном соединении.
 *
 * registerDocument берёт клиента из пула и держит его до COMMIT. Прежний код читал
 * правила нумерации и состояние периода ЧЕРЕЗ ПУЛ, то есть вторым соединением:
 * под нагрузкой это исчерпывало пул (10 регистраций вставали намертво, ожидая
 * соединение у самих себя), а чтение шло вне транзакции — то есть мимо её данных.
 *
 * Тест считает, сколько раз регистрация обращается к пулу за соединением.
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

const actor: Actor = { id: null, name: "Тестовый секретарь" };

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-journaltx-"));
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

beforeEach(async () => {
  await getDocflowPool().query(
    "TRUNCATE documents, document_emails, number_counters, number_archives, audit_log RESTART IDENTITY CASCADE"
  );
});

/** Считает выдачи соединений из пула: pool.query тоже ходит через pool.connect. */
async function countCheckouts<T>(fn: () => Promise<T>): Promise<{ result: T; checkouts: number }> {
  const pool = getDocflowPool() as unknown as { connect: (...args: unknown[]) => unknown };
  const original = pool.connect;
  let checkouts = 0;
  pool.connect = function (this: unknown, ...args: unknown[]) {
    checkouts++;
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    return { result: await fn(), checkouts };
  } finally {
    pool.connect = original;
  }
}

describe("регистрация документа", () => {
  test("обходится одним соединением: чтения внутри транзакции идут через её клиент", async () => {
    const { result, checkouts } = await countCheckouts(() =>
      registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, actor)
    );
    expect(result.regNumber).toBe("вх1");
    // Транзакция (1) и чтение готового документа после COMMIT (2).
    // Прежний код брал ещё два соединения — на правила нумерации и состояние периода.
    expect(checkouts).toBeLessThanOrEqual(2);
  });

  test("номер выдаётся по-прежнему последовательно", async () => {
    const first = await registerDocument({ summary: "Первое" }, actor);
    const second = await registerDocument({ summary: "Второе" }, actor);
    expect([first.regNumber, second.regNumber]).toEqual(["вх1", "вх2"]);
  });

  test("проверка периода работает и после перевода чтения на клиент транзакции", async () => {
    // Открыт 2025 год, в архив он не выгружен — 2026 открывать нельзя.
    const first = await registerDocument({ summary: "Документ 2025 года", regDate: "2025-06-01" }, actor);
    expect(first.regNumber).toBe("вх1");

    await expect(
      registerDocument({ summary: "Документ 2026 года", regDate: "2026-03-01" }, actor)
    ).rejects.toThrow(/не выгружен в архив/);
  });
});
