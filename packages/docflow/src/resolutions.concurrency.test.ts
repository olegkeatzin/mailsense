import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";
import { AppError } from "./errors.js";
import {
  approveResolution,
  confirmReport,
  createResolution,
  dispatchResolution,
  getResolution,
  reportExecution,
  requestApproval,
  revertDispatch
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
/** Сколько сессий прямо сейчас ждут блокировку строки. */
async function blockedSessions(): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity " +
      "WHERE datname = current_database() AND wait_event_type = 'Lock'"
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function waitForBlockedSessions(expected: number): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    if ((await blockedSessions()) >= expected) return;
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

  test("параллельные отчёт исполнителя и откат отправки: проходит ровно один", async () => {
    const id = await approvedResolution();
    await dispatchResolution(id, secretary, {});

    const holder = await getDocflowPool().connect();
    let report: Promise<Outcome>;
    let revert: Promise<Outcome>;
    try {
      await holder.query("BEGIN");
      // Держим строку исполнителя: отчёт записывается его транзакцией, но ещё не
      // закоммичен — ровно то состояние, в котором его не видит guard отката.
      await holder.query(
        "SELECT user_id FROM resolution_assignees WHERE resolution_id = $1 AND user_id = $2 FOR UPDATE",
        [id, executorA.id]
      );

      report = settle(reportExecution(id, executorA.id, { text: "Заявка подготовлена" }, executorA));
      await waitForBlockedSessions(1);

      revert = settle(revertDispatch(id, secretary, "Письмо не ушло"));

      // Ждём, пока откат либо завершится (прежнее поведение: отчёт ему не виден),
      // либо встанет на строке резолюции (отчёт держит её первым).
      let settled = false;
      void revert.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      const deadline = Date.now() + 10000;
      while (!settled && Date.now() < deadline) {
        if ((await blockedSessions()) >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }

    const [reportOutcome, revertOutcome] = await Promise.all([report, revert]);
    expect([reportOutcome.ok, revertOutcome.ok].filter(Boolean)).toHaveLength(1);

    // Откат обязан отказаться: по поручению уже идёт работа.
    expect(revertOutcome.ok).toBe(false);
    expect(revertOutcome.code).toBe("bad_state");
    // Отчёт записан — и вызов не должен «упасть после записи».
    expect(reportOutcome.ok).toBe(true);

    const rows = await getDocflowPool().query<{ report_at: string | null }>(
      "SELECT report_at FROM resolution_assignees WHERE resolution_id = $1 AND user_id = $2",
      [id, executorA.id]
    );
    expect(rows.rows[0].report_at).not.toBeNull();

    // Отчитался ответственный — поручение закрыто; состояние и отчёт согласованы:
    // «утверждено» с уже отчитавшимся исполнителем — это и есть та дыра.
    const after = await getResolution(id);
    expect(after!.status).toBe("done");
  }, 20000);

  test("параллельное подтверждение отчёта письмом и откат отправки: проходит ровно один", async () => {
    const id = await approvedResolution();
    await dispatchResolution(id, secretary, {});

    const holder = await getDocflowPool().connect();
    let confirm: Promise<Outcome>;
    let revert: Promise<Outcome>;
    try {
      await holder.query("BEGIN");
      // Тот же приём: подтверждение записывает отчёт, но ещё не закоммитило его.
      await holder.query(
        "SELECT user_id FROM resolution_assignees WHERE resolution_id = $1 AND user_id = $2 FOR UPDATE",
        [id, executorA.id]
      );

      confirm = settle(confirmReport(id, executorA.id, { text: "Отчёт из письма" }, secretary));
      await waitForBlockedSessions(1);

      revert = settle(revertDispatch(id, secretary, "Письмо не ушло"));

      let settled = false;
      void revert.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      const deadline = Date.now() + 10000;
      while (!settled && Date.now() < deadline) {
        if ((await blockedSessions()) >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }

    const [confirmOutcome, revertOutcome] = await Promise.all([confirm, revert]);
    expect([confirmOutcome.ok, revertOutcome.ok].filter(Boolean)).toHaveLength(1);

    // Откат обязан отказаться: отчёт по поручению уже принят.
    expect(revertOutcome.ok).toBe(false);
    expect(revertOutcome.code).toBe("bad_state");
    // Подтверждение не должно «упасть после записи».
    expect(confirmOutcome.ok).toBe(true);

    const rows = await getDocflowPool().query<{ report_at: string | null }>(
      "SELECT report_at FROM resolution_assignees WHERE resolution_id = $1 AND user_id = $2",
      [id, executorA.id]
    );
    expect(rows.rows[0].report_at).not.toBeNull();
    const after = await getResolution(id);
    expect(after!.status).toBe("done");
  }, 20000);
});
