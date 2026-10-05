import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";
import { listBoard, listReplyCandidates, listResolutions } from "./resolutions.js";

/**
 * N+1 на выдаче резолюций.
 *
 * Раньше listResolutions на каждую строку звала getResolutionDetail (5 запросов),
 * а listBoard грузит до 200 строк — около тысячи запросов на один экран канбана.
 * Здесь проверяется само свойство: число запросов на выдачу НЕ зависит от числа
 * строк, и 200 записей собираются быстрее 100 мс.
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

const secretary: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };
const executorA: Actor = { id: "u-exec-a", name: "Романов Е.С." };
const executorB: Actor = { id: "u-exec-b", name: "Барышникова Л.С." };

let dir = "";
let documentId = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-batch-"));
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
    "TRUNCATE resolutions, resolution_assignees, resolution_approvals, documents, document_emails, " +
      "number_counters, number_archives, audit_log, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  for (const u of [secretary, executorA, executorB]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.id + "@stand.test", u.name, ts, ts]
    );
  }
  const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, secretary);
  documentId = doc.id;
});

/** Данные для замера кладём одним запросом: замеряем выдачу, а не подготовку. */
async function seedResolutions(n: number, prefix: string, status: string): Promise<void> {
  const ts = new Date().toISOString();
  const pool = getDocflowPool();
  await pool.query(
    "INSERT INTO resolutions (id, document_id, text, source_text, source_kind, status, priority, deadline, " +
      "prepared_by, request_email_id, created_at, updated_at) " +
      "SELECT $1 || g, $2, 'Поручение ' || g, '', 'manual', $3, 'normal', '2099-12-31', $4, " +
      "CASE WHEN $3 = 'pending_approval' THEN 'request-' || g ELSE NULL END, $5, $5 " +
      "FROM generate_series(1, $6::int) g",
    [prefix, documentId, status, secretary.id, ts, n]
  );
  await pool.query(
    "INSERT INTO resolution_assignees (resolution_id, user_id, kind, created_at) " +
      "SELECT $1 || g, $2, 'responsible', $3 FROM generate_series(1, $4::int) g",
    [prefix, executorA.id, ts, n]
  );
  await pool.query(
    "INSERT INTO resolution_approvals (id, resolution_id, step, actor_id, actor_name, method, created_at) " +
      "SELECT $1 || 'appr-' || g, $1 || g, 'dispatched', $2, 'Аппарат', 'manual', $3 " +
      "FROM generate_series(1, $4::int) g",
    [prefix, secretary.id, ts, n]
  );
}

interface Measurement {
  queries: number;
  items: number;
  ms: number;
}

/** Считаем обращения к базе: пул — та самая точка, через которую идёт drizzle. */
async function measure(fn: () => Promise<{ items: unknown[] }>): Promise<Measurement> {
  const pool = getDocflowPool() as unknown as { query: (...args: unknown[]) => unknown };
  const original = pool.query;
  let queries = 0;
  pool.query = function (this: unknown, ...args: unknown[]) {
    queries++;
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  const t0 = Date.now();
  try {
    const page = await fn();
    return { queries, items: page.items.length, ms: Date.now() - t0 };
  } finally {
    pool.query = original;
  }
}

describe("выдача резолюций без N+1", () => {
  test("число запросов на выдачу не зависит от числа строк", async () => {
    await seedResolutions(3, "small-", "sent");
    const small = await measure(() => listResolutions({ limit: 200 }));
    await seedResolutions(9, "big-", "sent");
    const big = await measure(() => listResolutions({ limit: 200 }));

    expect(small.items).toBe(3);
    expect(big.items).toBe(12);
    // На прежнем коде было 5 запросов на строку: 17 против 62.
    expect(big.queries).toBe(small.queries);
    expect(small.queries).toBeLessThanOrEqual(10);
    // Детали обязаны быть собраны: без них «число запросов» ничего не значит.
    expect((await listResolutions({ limit: 200 })).items[0].assignees.length).toBe(1);
  });

  test("канбан руководителя на 200 записях собирается без тысяч запросов и быстрее 100 мс", async () => {
    await seedResolutions(200, "perf-", "sent");
    await listBoard(); // прогрев: соединения и планы запросов

    const measured = await measure(async () => {
      const columns = await listBoard();
      return { items: columns.flatMap((c) => c.items) };
    });

    // 200 поручений «в работе» + столько же в колонке «Просрочено» их не дублируют (срок 2099).
    expect(measured.items).toBeGreaterThanOrEqual(200);
    expect(measured.queries).toBeLessThanOrEqual(10);
    // Замер печатаем: иначе «стало быстрее» ничем не подтверждено.
    console.log(
      "[замер] listBoard, 200 записей: " + measured.queries + " запросов, " + measured.ms + " мс"
    );
    expect(measured.ms).toBeLessThan(100);
  });

  test("подсказки по тредам не тянут исполнителей по одной резолюции", async () => {
    await seedResolutions(12, "reply-", "pending_approval");
    const measured = await measure(async () => ({
      items: await listReplyCandidates()
    }));
    expect(measured.items).toBe(12);
    expect(measured.queries).toBeLessThanOrEqual(3);
  });
});
