import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { runDocflowMigrations } from "./db/migrate.js";
import { daysLeft, isOverdue } from "./deadlines.js";
import { companyDayIso } from "./companyDay.js";
import {
  DEFAULT_DUE_SOON_DAYS,
  materializeDeadlineNotifications,
  materializeDeadlineNotificationsSafe,
  saveNotificationSettings
} from "./notifications.js";

/**
 * Материализация уведомлений о сроках (этап 5, §3 контракта).
 *
 * Уведомления о сроках не рассылает cron: они ДОСЧИТЫВАЮТСЯ при чтении и идемпотентны
 * по dedupe_key. Здесь проверяются три свойства, ради которых это так устроено:
 * повторное чтение не плодит дубли, продление срока даёт новое напоминание,
 * а закрытая/отчитавшаяся задача не напоминает вовсе.
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

const EXECUTOR = "u-exec";
const CLERK = "u-clerk";
const admin = { id: "u-admin", name: "Администратор" };

let dir = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * Дата со сдвигом в днях от сегодняшнего.
 *
 * ⚠️ День считаем тем же правилом, что и сервер (день предприятия, T47): иначе в окне
 * 00:00–03:00 МСК тест строил бы «сегодня» по UTC и падал бы на ВЕРНОМ коде.
 */
function dayOffset(days: number): string {
  return companyDayIso(new Date(Date.now() + days * 86_400_000));
}

async function seedTask(opts: {
  resolutionId: string;
  deadline: string | null;
  status?: string;
  preparedBy?: string | null;
  reportAt?: string | null;
  assignee?: string;
}): Promise<void> {
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO documents (id, reg_number, reg_number_numeric, reg_period, reg_date, summary, created_at, updated_at) " +
      "VALUES ($1,'вх7',7,'2026','2026-01-01','Письмо о марафоне',$2,$2) ON CONFLICT (id) DO NOTHING",
    ["doc-" + opts.resolutionId, ts]
  );
  await sql(
    "INSERT INTO resolutions (id, document_id, text, status, priority, deadline, prepared_by, created_at, updated_at) " +
      "VALUES ($1,$2,'Подготовить ответ','" + (opts.status ?? "sent") + "','normal',$3,$4,$5,$5)",
    [opts.resolutionId, "doc-" + opts.resolutionId, opts.deadline, opts.preparedBy ?? CLERK, ts]
  );
  await sql(
    "INSERT INTO resolution_assignees (resolution_id, user_id, kind, report_at, created_at) VALUES ($1,$2,'responsible',$3,$4)",
    [opts.resolutionId, opts.assignee ?? EXECUTOR, opts.reportAt ?? null, ts]
  );
}

async function kindsFor(userId: string): Promise<string[]> {
  const rows = await getDocflowPool().query<{ kind: string }>(
    "SELECT kind FROM notifications WHERE user_id = $1 ORDER BY kind",
    [userId]
  );
  return rows.rows.map((r) => r.kind);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-deadline-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

const SHARED_TABLES =
  "notifications, notification_templates, mail_sort_rules, audit_log, resolution_assignees, " +
  "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
  "settings, sessions, user_roles, users RESTART IDENTITY CASCADE";

/**
 * Уборка за собой: база mailsense_test ОБЩАЯ для всех файлов прогона (rules §2.6, §3).
 * Без неё строка, оставленная этим файлом, ломает чужой тест, и падение зависит от порядка
 * файлов — так и всплыл красный «дефолтных правил сортировки НЕТ» на приёмке QA.
 */
async function cleanupSharedDb(): Promise<void> {
  await sql("TRUNCATE " + SHARED_TABLES);
}

/**
 * Доказательство, что уборка сделана: если снять TRUNCATE в cleanupSharedDb, падает ЗДЕСЬ,
 * а не в чужом файле через минуту. Проверяются ровно те таблицы, которые этот файл пишет.
 */
async function assertCleanedUp(): Promise<void> {
  expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
  expect(await count("SELECT count(*)::int AS n FROM settings")).toBe(0);
  expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(0);
}

afterAll(async () => {
  await cleanupSharedDb();
  await assertCleanedUp();
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await sql(
    "TRUNCATE notifications, notification_templates, mail_sort_rules, audit_log, resolution_assignees, " +
      "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
      "settings, sessions, user_roles, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,'e@stand.test','Романов Е.С.',$2,$2), ($3,'c@stand.test','Авдеева Ю.Н.',$2,$2)",
    [EXECUTOR, ts, CLERK]
  );
  await sql("DELETE FROM docflow_migrations WHERE version = 7");
  await runDocflowMigrations(getDocflowPool());
});

describe("сроки считаются в календарных днях", () => {
  test("сегодня — 0, завтра — 1, вчера — −1", () => {
    // День задаём строкой: результат не зависит ни от пояса машины, ни от часа запуска.
  const today = "2026-10-07";
    expect(daysLeft("2026-10-07", today)).toBe(0);
    expect(daysLeft("2026-10-08", today)).toBe(1);
    expect(daysLeft("2026-10-06", today)).toBe(-1);
    expect(daysLeft("2026-10-17", today)).toBe(10);
    expect(isOverdue("2026-10-06", today)).toBe(true);
    expect(isOverdue("2026-10-07", today)).toBe(false);
  });

  test("мусор на входе — null, а не NaN", () => {
    expect(daysLeft("завтра")).toBeNull();
    expect(daysLeft("")).toBeNull();
    expect(daysLeft(null)).toBeNull();
    expect(daysLeft("2026-13-40")).toBeNull();
  });
});

describe("материализация сроков", () => {
  test("срок сегодня — due_today (предупреждение), а не due_soon", async () => {
    await seedTask({ resolutionId: "r-today", deadline: dayOffset(0) });
    const created = await materializeDeadlineNotifications(EXECUTOR);
    expect(created).toBe(1);
    expect(await kindsFor(EXECUTOR)).toEqual(["resolution.due_today"]);
    const rows = await getDocflowPool().query<{ severity: string; title: string }>(
      "SELECT severity, title FROM notifications WHERE user_id = $1",
      [EXECUTOR]
    );
    expect(rows.rows[0].severity).toBe("warning");
    expect(rows.rows[0].title).toContain("вх7");
  });

  test("срок через 2 дня — due_soon", async () => {
    await seedTask({ resolutionId: "r-soon", deadline: dayOffset(2) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(1);
    expect(await kindsFor(EXECUTOR)).toEqual(["resolution.due_soon"]);
  });

  test("срок через 10 дней — тишина: предупреждать пока не о чем", async () => {
    await seedTask({ resolutionId: "r-far", deadline: dayOffset(10) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
    expect(await kindsFor(EXECUTOR)).toEqual([]);
  });

  test("порог предупреждения берётся из настройки: при 0 «завтра» молчит", async () => {
    await saveNotificationSettings({ dueSoonDays: 0 }, admin);
    await seedTask({ resolutionId: "r-tomorrow", deadline: dayOffset(1) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);

    await saveNotificationSettings({ dueSoonDays: 1 }, admin);
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(1);
    expect(await kindsFor(EXECUTOR)).toEqual(["resolution.due_soon"]);
  });

  test("просроченный срок — overdue, и НЕ due_today", async () => {
    await seedTask({ resolutionId: "r-late", deadline: dayOffset(-1) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(1);
    expect(await kindsFor(EXECUTOR)).toEqual(["resolution.overdue"]);
  });

  test("повторное чтение не плодит дубли", async () => {
    await seedTask({ resolutionId: "r-1", deadline: dayOffset(1) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(1);
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(1);
  });

  test("продление срока даёт новое напоминание: новый срок — новый ключ", async () => {
    await seedTask({ resolutionId: "r-1", deadline: dayOffset(1) });
    await materializeDeadlineNotifications(EXECUTOR);
    await sql("UPDATE resolutions SET deadline = $1 WHERE id = 'r-1'", [dayOffset(2)]);

    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [EXECUTOR])).toBe(2);
  });

  test("отчитавшийся исполнитель не получает напоминаний", async () => {
    await seedTask({ resolutionId: "r-done", deadline: dayOffset(-2), reportAt: new Date().toISOString() });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
  });

  test("закрытая задача не напоминает", async () => {
    await seedTask({ resolutionId: "r-closed", deadline: dayOffset(-2), status: "done" });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
  });

  test("задача без срока не напоминает", async () => {
    await seedTask({ resolutionId: "r-nodate", deadline: null });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
  });

  test("аппарат получает эскалацию по просроченному поручению", async () => {
    await seedTask({ resolutionId: "r-esc", deadline: dayOffset(-3), preparedBy: CLERK });
    expect(await materializeDeadlineNotifications(CLERK)).toBe(1);
    expect(await kindsFor(CLERK)).toEqual(["resolution.overdue_escalation"]);
    const rows = await getDocflowPool().query<{ severity: string }>(
      "SELECT severity FROM notifications WHERE user_id = $1",
      [CLERK]
    );
    expect(rows.rows[0].severity).toBe("danger");
  });

  test("выключенные уведомления не материализуются", async () => {
    await saveNotificationSettings({ enabled: false }, admin);
    await seedTask({ resolutionId: "r-off", deadline: dayOffset(-1) });
    expect(await materializeDeadlineNotifications(EXECUTOR)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(0);
  });
});

describe("лимит хранения: таблица не растёт вечно", () => {
  test("старые ПРОЧИТАННЫЕ удаляются, непрочитанные остаются", async () => {
    // 505 прочитанных (январь) и 3 непрочитанных (июнь) — всего 508.
    await sql(
      "INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, title, body, severity, dedupe_key, created_at, read_at) " +
        "SELECT 'old-'||i, $1, 'resolution.closed', 'resolution', 'res-old', 'т', '', 'info', 'old-'||i, " +
        "TIMESTAMPTZ '2026-01-01 00:00:00+00' + (i || ' seconds')::interval, now() FROM generate_series(1,505) i",
      [EXECUTOR]
    );
    await sql(
      "INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, title, body, severity, dedupe_key, created_at) " +
        "SELECT 'new-'||i, $1, 'resolution.assigned', 'resolution', 'res-new', 'т', '', 'info', 'new-'||i, " +
        "TIMESTAMPTZ '2026-06-01 00:00:00+00' + (i || ' seconds')::interval FROM generate_series(1,3) i",
      [EXECUTOR]
    );

    await materializeDeadlineNotifications(EXECUTOR);

    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [EXECUTOR])).toBe(500);
    // Непрочитанные не тронуты — их удалять нельзя, иначе напоминание исчезнет до прочтения.
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [EXECUTOR])).toBe(3);
    // Удалены самые старые прочитанные (первые восемь).
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE id IN ('old-1','old-2','old-3','old-8')")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE id = 'old-9'")).toBe(1);
  });

  test("пока уведомлений меньше лимита, не удаляется ничего", async () => {
    await sql(
      "INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, title, body, severity, dedupe_key, created_at, read_at) " +
        "SELECT 'old-'||i, $1, 'resolution.closed', 'resolution', 'res-old', 'т', '', 'info', 'old-'||i, now(), now() " +
        "FROM generate_series(1,10) i",
      [EXECUTOR]
    );
    await materializeDeadlineNotifications(EXECUTOR);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(10);
  });
});

describe("материализация не роняет чтение (§3)", () => {
  test("сбой записи уведомления логируется, а список отдаётся как есть", async () => {
    await seedTask({ resolutionId: "r-broken", deadline: dayOffset(-1) });
    await sql(
      "CREATE OR REPLACE FUNCTION test_block_notify() RETURNS trigger AS $$ " +
        "BEGIN RAISE EXCEPTION 'тест: запись уведомления недоступна'; END; $$ LANGUAGE plpgsql; " +
        "DROP TRIGGER IF EXISTS test_block_notify_trg ON notifications; " +
        "CREATE TRIGGER test_block_notify_trg BEFORE INSERT ON notifications " +
        "FOR EACH ROW EXECUTE FUNCTION test_block_notify();"
    );
    try {
      // Сырая материализация падает — и это правильно: сбой не должен быть незамеченным.
      await expect(materializeDeadlineNotifications(EXECUTOR)).rejects.toThrow();
      // А обёртка «на чтении» обязана проглотить сбой: центр уведомлений открывается,
      // просто без новых напоминаний. Иначе один сбойный триггер закрыл бы весь раздел.
      await expect(materializeDeadlineNotificationsSafe(EXECUTOR)).resolves.toBeUndefined();
    } finally {
      await sql(
        "DROP TRIGGER IF EXISTS test_block_notify_trg ON notifications; DROP FUNCTION IF EXISTS test_block_notify();"
      );
    }
  });
});

// Прямая ссылка на значение по умолчанию: если его поменяют, тест «порог из настройки»
// перестанет быть осмысленным — пусть падает явно.
test("порог по умолчанию — 3 дня", () => {
  expect(DEFAULT_DUE_SOON_DAYS).toBe(3);
});
