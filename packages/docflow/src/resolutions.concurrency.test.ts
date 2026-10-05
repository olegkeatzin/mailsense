import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";
import { AppError } from "./errors.js";
import {
  approveResolution,
  createResolution,
  dispatchResolution,
  getResolution,
  requestApproval
} from "./resolutions.js";

/**
 * Гонка переходов резолюции.
 *
 * Поручение, ушедшее дважды, — это два письма исполнителю и две записи в истории
 * по одному и тому же решению. Переход обязан быть сериализован: второй переход
 * видит уже новое состояние и отклоняется, а не «догоняет» первого.
 *
 * Тест детерминированный: строка резолюции блокируется отдельным соединением
 * (SELECT ... FOR UPDATE), затем запускаются два перехода. Оба обязаны застрять —
 * на блокировке строки. После снятия блокировки проходит ровно один.
 * На прежнем коде (чтение состояния без FOR UPDATE) проходили оба: чтение
 * блокировку не берёт, а UPDATE в PostgreSQL после ожидания применяется к строке.
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
const signer: Actor = { id: "u-signer", name: "Иванов И.И." };
const executorA: Actor = { id: "u-exec-a", name: "Романов Е.С." };

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-race-"));
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
  for (const u of [secretary, signer, executorA]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.id + "@stand.test", u.name, ts, ts]
    );
  }
});

/** Утверждённая резолюция: следующий шаг — отправка исполнителям. */
async function approvedResolution(): Promise<string> {
  const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, secretary);
  const draft = await createResolution(
    {
      documentId: doc.id,
      text: "Рассмотреть участие и подготовить заявку",
      assignees: [{ userId: executorA.id, kind: "responsible" }]
    },
    secretary
  );
  await requestApproval(draft.id, secretary, {});
  await approveResolution(draft.id, signer, {});
  const r = await getResolution(draft.id);
  if (!r || r.status !== "approved") throw new Error("Подготовка теста: резолюция не утверждена, статус " + r?.status);
  return draft.id;
}

interface Outcome {
  ok: boolean;
  code: string | null;
  message: string;
}

function settle(p: Promise<unknown>): Promise<Outcome> {
  return p.then(
    () => ({ ok: true, code: null, message: "" }),
    (err: unknown) => ({
      ok: false,
      code: err instanceof AppError ? err.code : null,
      message: err instanceof Error ? err.message : String(err)
    })
  );
}

/**
 * Ждём, пока обе транзакции встанут на блокировку строки.
 * Так тест не зависит от скорости машины: снятие блокировки происходит
 * только после того, как оба перехода реально стартовали и упёрлись в строку.
 */
async function waitForBlockedSessions(expected: number): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const rows = await getDocflowPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity " +
        "WHERE datname = current_database() AND wait_event_type = 'Lock'"
    );
    if (Number(rows.rows[0]?.n ?? 0) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error("Не дождались блокировки строки: параллельные переходы не стартовали");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("гонка переходов резолюции", () => {
  test("два параллельных перехода: проходит ровно один, второй отклоняется", async () => {
    const id = await approvedResolution();

    const holder = await getDocflowPool().connect();
    let first: Promise<Outcome>;
    let second: Promise<Outcome>;
    try {
      await holder.query("BEGIN");
      // Держим строку: оба перехода обязаны встать на ней, а не разойтись.
      await holder.query("SELECT id FROM resolutions WHERE id = $1 FOR UPDATE", [id]);

      first = settle(dispatchResolution(id, secretary, { comment: "первая отправка" }));
      second = settle(dispatchResolution(id, secretary, { comment: "вторая отправка" }));

      await waitForBlockedSessions(2);
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }

    const outcomes = await Promise.all([first, second]);
    const done = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    expect(done).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].code).toBe("bad_state");

    const after = await getResolution(id);
    expect(after!.status).toBe("sent");
    expect(after!.dispatchEmailId).toBeNull();

    // След перехода — ровно один: иначе в истории два «отправлено».
    const history = await getDocflowPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM resolution_approvals WHERE resolution_id = $1 AND step = 'dispatched'",
      [id]
    );
    expect(Number(history.rows[0].n)).toBe(1);
  });

  test("повторный переход по уже отправленному поручению отклоняется", async () => {
    const id = await approvedResolution();
    await dispatchResolution(id, secretary, {});
    await expect(dispatchResolution(id, secretary, {})).rejects.toThrow(/невозможно/);
  });
});
