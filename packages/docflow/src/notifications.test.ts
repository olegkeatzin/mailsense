import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
// Ядро берём по исходнику напрямую: в пакете docflow barrel @mailsense/core не смонтирован
// (он тянет почту и ИИ), а проверить связку «испорченная настройка → расчёт» нужно настоящую.
import { addWorkingDays } from "../../core/src/services/workingDays.js";
import { closeDocflowDb, getDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { runDocflowMigrations } from "./db/migrate.js";
import type { Actor } from "./journal.js";
import {
  countUnreadNotifications,
  getNotificationSettings,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notifyInTx,
  parseDueSoonDays,
  parseSettingBoolean,
  renderNotificationTemplate,
  saveNotificationSettings
} from "./notifications.js";

/**
 * Хранилище уведомлений (этап 5, §3–§4 контракта).
 *
 * Проверяем поведение: кто что видит, идемпотентность по dedupe_key, отказ «чужое
 * уведомление» на УРОВНЕ ДАННЫХ (каждый запрос обязан фильтровать по user_id —
 * это вторая линия защиты после requirePermission на маршруте) и атомарность
 * «настройки + след аудита».
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

const actor: Actor = { id: "u-admin", name: "Администратор" };
const USER_A = "u-a";
const USER_B = "u-b";

let dir = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

/** Уведомление «как из базы»: прямая вставка, чтобы проверять именно чтение. */
async function seedNotification(opts: {
  id: string;
  userId: string;
  kind: string;
  dedupeKey: string;
  entityId?: string;
  entityType?: string;
  title?: string;
  body?: string;
  severity?: string;
  createdAt?: string;
  readAt?: string | null;
}): Promise<void> {
  await sql(
    "INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, title, body, severity, dedupe_key, created_at, read_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      opts.id,
      opts.userId,
      opts.kind,
      opts.entityType ?? "resolution",
      opts.entityId ?? "res-1",
      opts.title ?? "Заголовок",
      opts.body ?? "",
      opts.severity ?? "info",
      opts.dedupeKey,
      opts.createdAt ?? new Date().toISOString(),
      opts.readAt ?? null
    ]
  );
}

/** Документ и резолюция: уведомление о сроке берёт дату из резолюции. */
async function seedResolution(id: string, deadline: string | null, preparedBy: string | null = null): Promise<void> {
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO documents (id, reg_number, reg_number_numeric, reg_period, reg_date, created_at, updated_at) " +
      "VALUES ($1,'вх1',1,'2026','2026-01-01',$2,$2) ON CONFLICT (id) DO NOTHING",
    ["doc-" + id, ts]
  );
  await sql(
    "INSERT INTO resolutions (id, document_id, text, status, priority, deadline, prepared_by, created_at, updated_at) " +
      "VALUES ($1,$2,'Подготовить ответ','sent','normal',$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING",
    [id, "doc-" + id, deadline, preparedBy, ts]
  );
}

/** Запись аудита падает с ошибкой СУБД — ровно то, что бывает при сбое. */
async function blockAudit(): Promise<void> {
  await sql(
    "CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger AS $$ " +
      "BEGIN RAISE EXCEPTION 'тест: запись аудита недоступна'; END; $$ LANGUAGE plpgsql; " +
      "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; " +
      "CREATE TRIGGER test_block_audit_trg BEFORE INSERT ON audit_log " +
      "FOR EACH ROW EXECUTE FUNCTION test_block_audit();"
  );
}

async function unblockAudit(): Promise<void> {
  await sql("DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; DROP FUNCTION IF EXISTS test_block_audit();");
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-notif-"));
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
  await unblockAudit().catch(() => undefined);
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
  await unblockAudit();
  await sql(
    "TRUNCATE notifications, notification_templates, mail_sort_rules, audit_log, resolution_assignees, " +
      "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
      "settings, sessions, user_roles, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$4), ($5,$6,$7,$4,$4)",
    [USER_A, "a@stand.test", "Пользователь А", ts, USER_B, "b@stand.test", "Пользователь Б"]
  );
  // Шаблоны удалены вместе с TRUNCATE — возвращаем их прогоном миграции v7.
  await sql("DELETE FROM docflow_migrations WHERE version = 7");
  await runDocflowMigrations(getDocflowPool());
});

afterEach(async () => {
  await unblockAudit();
});

describe("шаблон текста", () => {
  test("переменные подставляются, незнакомые остаются как есть", () => {
    const text = renderNotificationTemplate("Поручение {regNumber}: {text} до {deadline}", {
      regNumber: "вх12",
      text: "подготовить ответ",
      deadline: "2026-11-01"
    });
    expect(text).toBe("Поручение вх12: подготовить ответ до 2026-11-01");
    // Незнакомую переменную НЕ вырезаем молча: администратор должен увидеть опечатку.
    expect(renderNotificationTemplate("Срок {нетТакой}", {})).toBe("Срок {нетТакой}");
  });
});

describe("чтение настроек: мусор в базе не ломает работу", () => {
  test("по умолчанию: включено, за 3 дня, рабочие дни", async () => {
    const s = await getNotificationSettings();
    expect(s.enabled).toBe(true);
    expect(s.dueSoonDays).toBe(3);
    expect(s.workdayDeadlines).toBe(true);
    expect(s.templates).toHaveLength(8);
  });

  test("нечисловое «за N дней» и мусорный флаг читаются как значения по умолчанию", async () => {
    await sql("INSERT INTO settings (key, value) VALUES ('notifications.dueSoonDays','завтра'), ('notifications.enabled','может быть')");
    expect(parseDueSoonDays("завтра")).toBe(3);
    expect(parseSettingBoolean("может быть", true)).toBe(true);
    const s = await getNotificationSettings();
    expect(s.dueSoonDays).toBe(3);
    expect(s.enabled).toBe(true);
  });

  test("число вне 0..30 приводится к границе, а не роняет чтение", () => {
    expect(parseDueSoonDays("99")).toBe(30);
    expect(parseDueSoonDays("-5")).toBe(0);
    expect(parseDueSoonDays("0")).toBe(0);
    expect(parseDueSoonDays("7")).toBe(7);
    expect(parseDueSoonDays(null)).toBe(3);
  });
});

describe("сохранение настроек и след — одна операция", () => {
  test("настройки и шаблоны сохраняются, в аудит пишется след", async () => {
    await saveNotificationSettings(
      {
        enabled: false,
        dueSoonDays: 5,
        workdayDeadlines: false,
        templates: [{ key: "resolution.due_soon", title: "Срок на носу", body: "Поручение: {taskText}", isActive: true }]
      },
      actor
    );

    const s = await getNotificationSettings();
    expect(s).toMatchObject({ enabled: false, dueSoonDays: 5, workdayDeadlines: false });
    expect(s.templates.find((t) => t.key === "resolution.due_soon")).toMatchObject({
      title: "Срок на носу",
      body: "Поручение: {taskText}",
      isActive: true
    });
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'notifications.settings'")).toBe(1);
  });

  test("сбой записи аудита откатывает и настройки, и шаблоны", async () => {
    await blockAudit();
    await expect(
      saveNotificationSettings(
        {
          enabled: false,
          dueSoonDays: 9,
          templates: [{ key: "resolution.assigned", title: "Подмена", body: "x", isActive: false }]
        },
        actor
      )
    ).rejects.toThrow();

    const s = await getNotificationSettings();
    expect(s.enabled).toBe(true);
    expect(s.dueSoonDays).toBe(3);
    expect(s.templates.find((t) => t.key === "resolution.assigned")!.title).not.toBe("Подмена");
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });

  test("неизвестный вид уведомления и пустой заголовок отклоняются", async () => {
    await expect(
      saveNotificationSettings({ templates: [{ key: "resolution.что_то", title: "т", body: "", isActive: true }] }, actor)
    ).rejects.toMatchObject({ status: 400, code: "bad_template_key" });
    await expect(
      saveNotificationSettings({ templates: [{ key: "resolution.assigned", title: "   ", body: "", isActive: true }] }, actor)
    ).rejects.toMatchObject({ status: 400, code: "bad_template_title" });
    await expect(saveNotificationSettings({ dueSoonDays: 31 }, actor)).rejects.toMatchObject({
      status: 400,
      code: "bad_due_soon_days"
    });
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });
});

describe("создание уведомления", () => {
  test("заголовок и текст берутся из шаблона, важность и ссылка — из вида", async () => {
    const first = await getDocflowDb().transaction(async (tx) =>
      notifyInTx(tx, {
        userId: USER_A,
        kind: "resolution.assigned",
        entityId: "res-1",
        dedupeKey: "resolution.assigned:res-1:2026-11-01",
        vars: { regNumber: "вх1", text: "Подготовить ответ", deadline: "01.11.2026" }
      })
    );

    expect(first).toBe(true);
    const rows = await getDocflowPool().query<{ title: string; body: string; severity: string }>(
      "SELECT title, body, severity FROM notifications WHERE user_id = $1",
      [USER_A]
    );
    expect(rows.rows[0].title).toContain("вх1");
    expect(rows.rows[0].body).toContain("Подготовить ответ");
    expect(rows.rows[0].severity).toBe("info");

    const page = await listNotifications(USER_A);
    expect(page.items[0]).toMatchObject({ kind: "resolution.assigned", link: "tasks", severity: "info" });
  });

  test("повторная вставка с тем же dedupe_key не плодит дубль", async () => {
    await getDocflowDb().transaction(async (tx) => {
      await notifyInTx(tx, { userId: USER_A, kind: "resolution.assigned", entityId: "res-1", dedupeKey: "same-key" });
    });
    const second = await getDocflowDb().transaction(async (tx) =>
      notifyInTx(tx, { userId: USER_A, kind: "resolution.assigned", entityId: "res-1", dedupeKey: "same-key" })
    );

    expect(second).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(1);
  });

  test("выключенный выключатель уведомлений молчит", async () => {
    await saveNotificationSettings({ enabled: false }, actor);
    const created = await getDocflowDb().transaction(async (tx) =>
      notifyInTx(tx, { userId: USER_A, kind: "resolution.assigned", entityId: "res-1", dedupeKey: "k-1" })
    );
    expect(created).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(0);
  });

  test("выключенный вид уведомления не создаётся: это выбор администратора", async () => {
    await saveNotificationSettings(
      { templates: [{ key: "resolution.assigned", title: "Новое поручение", body: "x", isActive: false }] },
      actor
    );
    const created = await getDocflowDb().transaction(async (tx) =>
      notifyInTx(tx, { userId: USER_A, kind: "resolution.assigned", entityId: "res-1", dedupeKey: "k-1" })
    );
    expect(created).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM notifications")).toBe(0);
  });

  test("пропавший шаблон не приводит к тихой потере уведомления", async () => {
    await sql("DELETE FROM notification_templates WHERE key = 'resolution.assigned'");
    const created = await getDocflowDb().transaction(async (tx) =>
      notifyInTx(tx, { userId: USER_A, kind: "resolution.assigned", entityId: "res-1", dedupeKey: "k-1" })
    );
    expect(created).toBe(true);
    const rows = await getDocflowPool().query<{ title: string }>("SELECT title FROM notifications");
    expect(rows.rows[0].title.trim().length).toBeGreaterThan(0);
  });
});

describe("чтение и прочтение: своё видно, чужое — нет", () => {
  test("список отдаёт только свои строки, от новых к старым", async () => {
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.assigned", dedupeKey: "k1", createdAt: "2026-10-01T10:00:00.000Z" });
    await seedNotification({ id: "n-2", userId: USER_A, kind: "resolution.closed", dedupeKey: "k2", createdAt: "2026-10-02T10:00:00.000Z" });
    await seedNotification({ id: "n-3", userId: USER_B, kind: "resolution.assigned", dedupeKey: "k3", createdAt: "2026-10-03T10:00:00.000Z" });

    const page = await listNotifications(USER_A);
    expect(page.items.map((i) => i.id)).toEqual(["n-2", "n-1"]);
    expect(page.total).toBe(2);
    expect(page.unread).toBe(2);
    // Чужое уведомление не попадает в список даже при живом id.
    expect(page.items.some((i) => i.id === "n-3")).toBe(false);
  });

  test("unread=1 отдаёт только непрочитанные", async () => {
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.assigned", dedupeKey: "k1", readAt: "2026-10-02T10:00:00.000Z" });
    await seedNotification({ id: "n-2", userId: USER_A, kind: "resolution.closed", dedupeKey: "k2" });

    const page = await listNotifications(USER_A, { unreadOnly: true });
    expect(page.items.map((i) => i.id)).toEqual(["n-2"]);
    expect(page.unread).toBe(1);
  });

  test("deadline и daysLeft считаются на чтении из резолюции", async () => {
    const inFiveDays = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await seedResolution("res-1", inFiveDays);
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.due_soon", dedupeKey: "k1", entityId: "res-1" });

    const page = await listNotifications(USER_A);
    expect(page.items[0].deadline).toBe(inFiveDays);
    expect(page.items[0].daysLeft).toBe(5);
    expect(typeof page.items[0].createdAt).toBe("string");
  });

  test("своё уведомление помечается прочитанным, повторный вызов безопасен", async () => {
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.assigned", dedupeKey: "k1" });

    const first = await markNotificationRead("n-1", USER_A);
    expect(first).toEqual({ ok: true, unread: 0 });
    const again = await markNotificationRead("n-1", USER_A);
    expect(again).toEqual({ ok: true, unread: 0 });
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0); // прочтение — не след изменения
  });

  test("ЧУЖОЕ уведомление не читается и не помечается прочитанным (IDOR на уровне данных)", async () => {
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.assigned", dedupeKey: "k1" });

    // Чужому — «не найдено»: 403 выдал бы само существование записи.
    expect(await markNotificationRead("n-1", USER_B)).toBeNull();
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE id = 'n-1' AND read_at IS NOT NULL")).toBe(0);
    expect(await countUnreadNotifications(USER_B)).toBe(0);
  });

  test("read-all обновляет только свои строки и возвращает число", async () => {
    await seedNotification({ id: "n-1", userId: USER_A, kind: "resolution.assigned", dedupeKey: "k1" });
    await seedNotification({ id: "n-2", userId: USER_A, kind: "resolution.closed", dedupeKey: "k2" });
    await seedNotification({ id: "n-3", userId: USER_B, kind: "resolution.assigned", dedupeKey: "k3" });

    const updated = await markAllNotificationsRead(USER_A);
    expect(updated).toBe(2);
    expect(await countUnreadNotifications(USER_A)).toBe(0);
    // Чужие уведомления остались непрочитанными.
    expect(await countUnreadNotifications(USER_B)).toBe(1);
    expect(await markAllNotificationsRead(USER_A)).toBe(0);
  });
});
describe("праздники: настройка не должна ломать расчёт (А3, D-1)", () => {
  test("несуществующая дата отклоняется: 2026-02-30 не должен молча стать 2026-03-02", async () => {
    for (const bad of ["2026-02-30", "2026-04-31", "2027-02-29"]) {
      await expect(saveNotificationSettings({ holidays: [bad] }, actor)).rejects.toMatchObject({
        status: 400,
        code: "bad_holidays"
      });
    }
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });

  test("валидные праздники сохраняются, дубли убираются", async () => {
    await saveNotificationSettings({ holidays: ["2026-05-09", "2026-05-01", "2026-05-09"] }, actor);
    expect((await getNotificationSettings()).holidays).toEqual(["2026-05-01", "2026-05-09"]);
  });

  test("больше 100 дат отклоняется", async () => {
    const many = Array.from({ length: 101 }, (_, i) => "2026-01-" + String((i % 28) + 1).padStart(2, "0"));
    await expect(saveNotificationSettings({ holidays: many }, actor)).rejects.toMatchObject({
      status: 400,
      code: "bad_holidays"
    });
  });

  test("кривой формат отклоняется; испорченная настройка при чтении отбрасывается", async () => {
    await expect(saveNotificationSettings({ holidays: ["09.05.2026"] }, actor)).rejects.toMatchObject({
      status: 400,
      code: "bad_holidays"
    });
    // Такую настройку мог записать старый код или человек руками. Ядро (workingDays)
    // на несуществующую дату бросает RangeError — до расчёта она доходить не должна.
    await sql(
      "INSERT INTO settings (key, value) VALUES ('deadlines.holidays','[\"2026-02-30\",\"мусор\",\"2026-05-09\"]')"
    );
    expect((await getNotificationSettings()).holidays).toEqual(["2026-05-09"]);
  });

  test("испорченная настройка праздников не ломает расчёт срока (А9/А10)", async () => {
    await sql(
      "INSERT INTO settings (key, value) VALUES ('deadlines.holidays','[\"2026-02-30\",\"2026-05-09\"]')"
    );
    const settings = await getNotificationSettings();
    // 30 февраля отброшено, реальный праздник остался.
    expect(settings.holidays).toEqual(["2026-05-09"]);
    // Ядро на несуществующую дату бросает RangeError: до него доходит только валидная дата.
    expect(() => addWorkingDays("2026-05-12", 3, settings.holidays)).not.toThrow();
    expect(addWorkingDays("2026-05-12", 3, settings.holidays)).toBe("2026-05-15");
  });

  test("переменные шаблона отдаются клиенту: имена заморожены (А2)", async () => {
    expect((await getNotificationSettings()).variables.map((v) => v.key)).toEqual([
      "regNumber",
      "summary",
      "sender",
      "deadline",
      "daysLeft",
      "text",
      "author"
    ]);
  });
});
