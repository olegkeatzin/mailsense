import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { runDocflowMigrations } from "./db/migrate.js";
import { registerDocument, type Actor } from "./journal.js";
import {
  approveResolution,
  createResolution,
  dispatchResolution,
  getResolution,
  closeResolution,
  reportExecution,
  requestApproval
} from "./resolutions.js";
import { saveNotificationSettings } from "./notifications.js";

/**
 * Событийные уведомления (§3 контракта).
 *
 * Ключевое требование: уведомление пишется В ТОЙ ЖЕ ТРАНЗАКЦИИ, что и изменение.
 * Доказываем это не «строкой в таблице», а отказом записи уведомления на уровне СУБД:
 * если после такого отказа поручение всё равно ушло — транзакция не общая, и на сбое
 * исполнитель получил бы поручение, о котором никто не знает.
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
const executorB: Actor = { id: "u-exec-b", name: "Барышникова Л.С." };

let dir = "";
let documentId = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function kindsOf(userId: string): Promise<string[]> {
  const rows = await getDocflowPool().query<{ kind: string }>(
    "SELECT kind FROM notifications WHERE user_id = $1 ORDER BY kind",
    [userId]
  );
  return rows.rows.map((r) => r.kind);
}

async function allNotifications(): Promise<Array<{ user_id: string; kind: string; title: string; body: string }>> {
  const rows = await getDocflowPool().query<{ user_id: string; kind: string; title: string; body: string }>(
    "SELECT user_id, kind, title, body FROM notifications ORDER BY user_id, kind"
  );
  return rows.rows;
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

/** Запись уведомления падает с ошибкой СУБД — проверяем атомарность изменения и следа. */
async function blockNotifications(): Promise<void> {
  await sql(
    "CREATE OR REPLACE FUNCTION test_block_notify() RETURNS trigger AS $$ " +
      "BEGIN RAISE EXCEPTION 'тест: запись уведомления недоступна'; END; $$ LANGUAGE plpgsql; " +
      "DROP TRIGGER IF EXISTS test_block_notify_trg ON notifications; " +
      "CREATE TRIGGER test_block_notify_trg BEFORE INSERT ON notifications " +
      "FOR EACH ROW EXECUTE FUNCTION test_block_notify();"
  );
}

async function unblockNotifications(): Promise<void> {
  await sql(
    "DROP TRIGGER IF EXISTS test_block_notify_trg ON notifications; DROP FUNCTION IF EXISTS test_block_notify();"
  );
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-events-"));
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
  await unblockNotifications().catch(() => undefined);
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
  await unblockNotifications();
  await sql(
    "TRUNCATE notifications, notification_templates, mail_sort_rules, audit_log, resolution_assignees, " +
      "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
      "settings, sessions, user_roles, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  for (const u of [secretary, signer, executorA, executorB]) {
    await sql("INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)", [
      u.id,
      u.id + "@stand.test",
      u.name,
      ts
    ]);
  }
  await sql("DELETE FROM docflow_migrations WHERE version = 7");
  await runDocflowMigrations(getDocflowPool());
  const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, secretary);
  documentId = doc.id;
});

afterEach(async () => {
  await unblockNotifications();
});

/** Черновик → на утверждении → утверждён. */
async function approved(): Promise<string> {
  const draft = await createResolution(
    {
      documentId,
      text: "Рассмотреть участие и подготовить заявку",
      deadline: "2026-11-01",
      assignees: [
        { userId: executorA.id, kind: "responsible" },
        { userId: executorB.id, kind: "coexecutor" }
      ]
    },
    secretary
  );
  await requestApproval(draft.id, secretary);
  await approveResolution(draft.id, signer);
  return draft.id;
}

describe("поручение ушло — исполнители узнали", () => {
  test("уведомление получает КАЖДЫЙ исполнитель, с номером документа и текстом поручения", async () => {
    const id = await approved();
    await dispatchResolution(id, secretary);

    expect(await kindsOf(executorA.id)).toEqual(["resolution.assigned"]);
    expect(await kindsOf(executorB.id)).toEqual(["resolution.assigned"]);

    const rows = await getDocflowPool().query<{ title: string; body: string; severity: string }>(
      "SELECT title, body, severity FROM notifications WHERE user_id = $1",
      [executorA.id]
    );
    expect(rows.rows[0].severity).toBe("info");
    expect(rows.rows[0].title).not.toContain("{");
    expect(rows.rows[0].body).toContain("Рассмотреть участие");
  });

  test("повторный вызов отправки не создаёт второе уведомление (поручение уходит один раз)", async () => {
    const id = await approved();
    await dispatchResolution(id, secretary);
    // Поручение уже отправлено — второй переход отклоняется, дубля быть не может.
    await expect(dispatchResolution(id, secretary)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'resolution.assigned'")).toBe(2);
  });

  test("сбой записи уведомления откатывает САМО поручение — транзакция общая", async () => {
    const id = await approved();
    await blockNotifications();

    await expect(dispatchResolution(id, secretary)).rejects.toThrow();

    // Статус остался «утверждено»: письмо уйти не могло, значит и поручение не выдано.
    expect((await getResolution(id))!.status).toBe("approved");
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.dispatch'")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM resolution_approvals WHERE step = 'dispatched'")).toBe(0);
  });

  test("выключенные уведомления не мешают работе: поручение уходит", async () => {
    await saveNotificationSettings({ enabled: false }, secretary);
    const id = await approved();
    await dispatchResolution(id, secretary);

    expect((await getResolution(id))!.status).toBe("sent");
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(0);
  });
});

describe("утверждение", () => {
  test("аппарат получает уведомление об утверждении (способ А)", async () => {
    const id = await approved();
    expect(await kindsOf(secretary.id)).toEqual(["resolution.approved"]);
    // Утвердивший (подписант) уведомления о собственном действии не получает.
    expect(await kindsOf(signer.id)).toEqual([]);
    expect(id).toBeTruthy();
  });

  test("черновик, заведённый аппаратом через пересылку, тоже сообщает об утверждении", async () => {
    const draft = await createResolution(
      { documentId, text: "Подготовить ответ", deadline: null, assignees: [{ userId: executorA.id }] },
      secretary
    );
    await requestApproval(draft.id, secretary);
    await approveResolution(draft.id, signer, { text: "Подготовить ответ в срок" });
    expect(await kindsOf(secretary.id)).toEqual(["resolution.approved"]);
  });
});

describe("отчёт и закрытие", () => {
  test("отчёт исполнителя виден аппарату и подписанту", async () => {
    const id = await approved();
    await dispatchResolution(id, secretary);
    await sql("DELETE FROM notifications"); // уведомления о назначении не мешают проверке

    await reportExecution(id, executorB.id, { text: "Проект заявки готов" }, executorB);

    expect(await kindsOf(secretary.id)).toEqual(["resolution.reported"]);
    expect(await kindsOf(signer.id)).toEqual(["resolution.reported"]);
    const rows = await getDocflowPool().query<{ body: string }>(
      "SELECT body FROM notifications WHERE user_id = $1",
      [signer.id]
    );
    expect(rows.rows[0].body).toContain("Барышникова");
  });

  test("закрытие поручения аппаратом сообщает утвердившему и исполнителям", async () => {
    const id = await approved();
    await dispatchResolution(id, secretary);
    await sql("DELETE FROM notifications");

    await closeResolution(id, secretary, "исполнено лично");

    expect(await kindsOf(signer.id)).toEqual(["resolution.closed"]);
    expect(await kindsOf(executorA.id)).toEqual(["resolution.closed"]);
    expect(await kindsOf(executorB.id)).toEqual(["resolution.closed"]);
  });

  test("автозакрытие по отчёту ответственного тоже сообщает о закрытии", async () => {
    const draft = await createResolution(
      {
        documentId,
        text: "Подготовить справку",
        assignees: [{ userId: executorA.id, kind: "responsible" }]
      },
      secretary
    );
    await requestApproval(draft.id, secretary);
    await approveResolution(draft.id, signer);
    await dispatchResolution(draft.id, secretary);
    await sql("DELETE FROM notifications");

    await reportExecution(draft.id, executorA.id, { text: "Справка готова" }, executorA);

    expect((await getResolution(draft.id))!.status).toBe("done");
    // Отчитавшийся об отчёте не уведомляется (это его действие), но о закрытии — да.
    expect(await kindsOf(executorA.id)).toEqual(["resolution.closed"]);
    // Утвердивший получает и отчёт, и закрытие: это два разных события.
    expect(await kindsOf(signer.id)).toEqual(["resolution.closed", "resolution.reported"]);
  });
});

// Проверка, что «письма-напоминания» не появились побочным эффектом: ни одна строка
// уведомлений не несёт признаков почтовой рассылки. Сам запрет проверяется на маршрутах.
test("в уведомлениях нет e-mail-адресов — это внутренний центр, а не рассылка", async () => {
  const id = await approved();
  await dispatchResolution(id, secretary);
  const rows = await allNotifications();
  for (const r of rows) {
    expect(r.title + " " + r.body).not.toMatch(/@/);
  }
});
