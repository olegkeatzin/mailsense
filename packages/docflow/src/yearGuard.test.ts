import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { closePeriod, getNumberingState, registerDocument, reopenPeriod, type Actor } from "./journal.js";
import { AppError } from "./errors.js";

/**
 * Защита от случайного закрытия года.
 *
 * Три уровня: подтверждение года (маршрут), отмена закрытия ровно пока в новом году пусто,
 * и снимок перед закрытием. Здесь — ЯДРО: закрытие/отмена, следы в аудите и гонка.
 *
 * Гонка проверяется детерминированно: блокировка строки счётчика держится ОТДЕЛЬНЫМ
 * соединением, и тест ждёт, пока обе операции реально встанут на ней (pg_stat_activity),
 * а не «сколько-то миллисекунд». Выигравший определяется сам, проверяется ИНВАРИАНТ:
 * система не остаётся в противоречивом состоянии.
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

const admin: Actor = { id: "u-admin", name: "Администратор Системы" };
const secretary: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-yearguard-"));
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
    "TRUNCATE documents, document_emails, number_counters, number_archives, audit_log, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  for (const u of [admin, secretary]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.id + "@stand.test", u.name, ts, ts]
    );
  }
});

/** Регистрирует документ в указанном году: дата регистрации задаёт период. */
async function register(year: string, summary = "Письмо"): Promise<string> {
  const doc = await registerDocument({ summary, sender: "АО «ОПК»", regDate: year + "-01-15" }, secretary);
  return doc.id;
}

async function auditRows(action: string): Promise<Array<{ userName: string; newValue: unknown }>> {
  const rows = await getDocflowPool().query<{ user_name: string; new_value: unknown }>(
    "SELECT user_name, new_value FROM audit_log WHERE action = $1 ORDER BY created_at",
    [action]
  );
  return rows.rows.map((r) => ({ userName: r.user_name, newValue: r.new_value }));
}

async function archiveCount(period: string): Promise<number> {
  const rows = await getDocflowPool().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM number_archives WHERE stream = 'incoming' AND period = $1",
    [period]
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/** Держит строку счётчика периода отдельным соединением — как настоящая параллельная работа. */
async function holdCounter(period: string): Promise<{ release: () => Promise<void> }> {
  const holder = await getDocflowPool().connect();
  await holder.query("BEGIN");
  await holder.query(
    "INSERT INTO number_counters (stream, period, last_number) VALUES ('incoming', $1, 0) " +
      "ON CONFLICT (stream, period) DO NOTHING",
    [period]
  );
  await holder.query("SELECT 1 FROM number_counters WHERE stream = 'incoming' AND period = $1 FOR UPDATE", [period]);
  return {
    async release() {
      await holder.query("COMMIT");
      holder.release();
    }
  };
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
      throw new Error("Не дождались блокировки: параллельные операции не стартовали");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const close = (documentCount: number) =>
  closePeriod({ period: "2026", fileName: "journal-2026-20261006-120000.zip", documentCount }, admin);

describe("закрытие года", () => {
  test("закрывает открытый год, пишет архив и след с автором", async () => {
    await register("2026");

    const res = await close(1);

    expect(res.period).toBe("2026");
    expect(res.documentCount).toBe(1);
    const state = await getNumberingState();
    expect(state.archivedPeriods).toContain("2026");
    const audit = await auditRows("journal.archive_period");
    expect(audit).toHaveLength(1);
    expect(audit[0].userName).toBe(admin.name);
  });

  test("закрыть можно только открытый год", async () => {
    await register("2026");

    const bad = await settle(closePeriod({ period: "2027", documentCount: 0 }, admin));

    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("not_open_period");
    expect(await archiveCount("2027")).toBe(0);
  });

  test("повторное закрытие — отказ, а не тихий «успех»", async () => {
    await register("2026");
    await close(1);

    const again = await settle(close(1));

    // Раньше повторная выгрузка молча ничего не делала и отвечала «ок»: человек считал,
    // что год закрыт заново, а записи не менялись.
    expect(again.ok).toBe(false);
    expect(again.code).toBe("already_archived");
    expect(await archiveCount("2026")).toBe(1);
  });

  test("снимок устарел: во время выгрузки зарегистрировали документ — закрытие отклонено", async () => {
    await register("2026");
    // «Выгрузка» увидела один документ, а к моменту закрытия их стало два:
    // такой архив неполный, и закрывать год по нему нельзя.
    await register("2026");

    const stale = await settle(close(1));

    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("period_changed");
    expect(await archiveCount("2026")).toBe(0);
  });
});

describe("отмена закрытия года", () => {
  test("сразу после закрытия проходит: запись снята, в аудите причина и автор", async () => {
    await register("2026");
    await close(1);

    const res = await reopenPeriod({ period: "2026", reason: "Закрыли по ошибке" }, admin);

    expect(res.period).toBe("2026");
    const state = await getNumberingState();
    expect(state.archivedPeriods).not.toContain("2026");
    const audit = await auditRows("journal.reopen_period");
    expect(audit).toHaveLength(1);
    expect(audit[0].userName).toBe(admin.name);
    expect(JSON.stringify(audit[0].newValue)).toContain("Закрыли по ошибке");
  });

  test("после первого документа нового года отмена запрещена, причина называет год", async () => {
    await register("2026");
    await close(1);
    await register("2027", "Письмо нового года");

    const denied = await settle(reopenPeriod({ period: "2026", reason: "передумали" }, admin));

    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("reopen_not_allowed");
    // «Нельзя» без объяснения человек проверить не может.
    expect(denied.message).toContain("2027");
    expect(await archiveCount("2026")).toBe(1);
  });

  test("незакрытый год отменять нечего", async () => {
    await register("2026");

    const denied = await settle(reopenPeriod({ period: "2026", reason: "передумали" }, admin));

    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("not_archived");
  });

  test("причина обязательна: пустая не принимается и в ядре", async () => {
    await register("2026");
    await close(1);

    const denied = await settle(reopenPeriod({ period: "2026", reason: "   " }, admin));

    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("bad_reason");
    expect(await archiveCount("2026")).toBe(1);
  });

  test("после отмены год снова закрывается — состояние не залипло", async () => {
    await register("2026");
    await close(1);
    await reopenPeriod({ period: "2026", reason: "ошиблись" }, admin);

    const again = await close(1);

    expect(again.period).toBe("2026");
    expect(await archiveCount("2026")).toBe(1);
  });
});

describe("порядок захвата: регистрация ждёт строку ДО чтения состояния", () => {
  test("год закрыли, пока регистрация ждала блокировку — документ в закрытый год не попал", async () => {
    await register("2026");
    const holder = await getDocflowPool().connect();
    let outcome: Outcome;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "INSERT INTO number_counters (stream, period, last_number) VALUES ('incoming','2026',0) " +
          "ON CONFLICT (stream, period) DO NOTHING"
      );
      await holder.query("SELECT 1 FROM number_counters WHERE stream='incoming' AND period='2026' FOR UPDATE");

      const registering = settle(register("2026", "Письмо во время закрытия"));
      // Регистрация обязана встать на строке счётчика ДО чтения состояния периода.
      await waitForBlockedSessions(1);

      // Пока она ждёт, год закрывают (та же транзакция держателя — как настоящий конкурент).
      await holder.query(
        "INSERT INTO number_archives (id, stream, period, file_name, document_count, created_at, created_by) " +
          "VALUES ($1,'incoming','2026','journal-2026.zip',1,$2,$3)",
        ["arch-" + Date.now(), new Date().toISOString(), admin.id]
      );
      await holder.query("COMMIT");

      outcome = await registering;
    } finally {
      holder.release();
    }

    // Если бы регистрация читала состояние ДО блокировки, она прошла бы по устаревшим данным
    // и записала документ в уже закрытый год — тот самый документ, которого нет в архиве.
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("period_closed");
    const docs = await getDocflowPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM documents WHERE reg_period = '2026'"
    );
    expect(Number(docs.rows[0].n)).toBe(1);
  });
});

describe("гонка: закрытие и регистрация", () => {
  test("ровно одна сторона проходит, противоречивого состояния не остаётся", async () => {
    await register("2026");
    const holder = await holdCounter("2026");
    let closing: Promise<Outcome>;
    let registering: Promise<Outcome>;
    try {
      closing = settle(close(1));
      registering = settle(register("2026", "Письмо во время закрытия"));
      // Обе операции обязаны встать на строке счётчика: закрытие её блокирует,
      // регистрация — тоже (иначе она прошла бы мимо и в закрытом году появился бы
      // документ, которого нет в архиве).
      await waitForBlockedSessions(2);
    } finally {
      await holder.release();
    }
    const [closeOutcome, registerOutcome] = await Promise.all([closing, registering]);

    expect([closeOutcome.ok, registerOutcome.ok].filter(Boolean)).toHaveLength(1);
    if (closeOutcome.ok) {
      // Закрыли первыми: год закрыт, архив есть, а регистрация в закрытый год отклонена.
      expect(registerOutcome.code).toBe("period_closed");
      expect(await archiveCount("2026")).toBe(1);
    } else {
      // Зарегистрировали первыми: закрытие отклонилось, потому что снимок устарел.
      expect(closeOutcome.code).toBe("period_changed");
      expect(await archiveCount("2026")).toBe(0);
    }
    // В закрытом году не может быть документа, которого нет в архиве.
    const docs = await getDocflowPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM documents WHERE reg_period = '2026'"
    );
    expect(Number(docs.rows[0].n)).toBe(closeOutcome.ok ? 1 : 2);
  });
});

describe("гонка: отмена и регистрация нового года", () => {
  test("отмена не состоится, если документ нового года успел пройти", async () => {
    await register("2026");
    await close(1);
    const holder = await holdCounter("2027");
    let reopening: Promise<Outcome>;
    let registering: Promise<Outcome>;
    try {
      reopening = settle(reopenPeriod({ period: "2026", reason: "передумали" }, admin));
      registering = settle(register("2027", "Письмо нового года"));
      await waitForBlockedSessions(2);
    } finally {
      await holder.release();
    }
    const [reopenOutcome, registerOutcome] = await Promise.all([reopening, registering]);

    // Главное: НЕ может быть так, что год переоткрыли и одновременно выдали номер в новом году.
    expect([reopenOutcome.ok, registerOutcome.ok].filter(Boolean)).toHaveLength(1);
    if (reopenOutcome.ok) {
      // Отмена прошла первой: новый год открывать нельзя — предыдущий снова не выгружен.
      expect(registerOutcome.code).toBe("period_closed");
      expect(await archiveCount("2026")).toBe(0);
    } else {
      expect(reopenOutcome.code).toBe("reopen_not_allowed");
      expect(await archiveCount("2026")).toBe(1);
    }
    const docs = await getDocflowPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM documents WHERE reg_period = '2027'"
    );
    expect(Number(docs.rows[0].n)).toBe(reopenOutcome.ok ? 0 : 1);
  });
});
