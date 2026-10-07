import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import type { Actor } from "./journal.js";
import {
  listUserActivityStats,
  recomputeUserStats,
  setUserStatsMailFactsProvider
} from "./userStats.js";

/**
 * Агрегат «профиль исполнителя» (task-18): данные под будущую подсказку исполнителей.
 *
 * Сама подсказка НЕ реализуется (граф знаний — после 0.1.4), но агрегат обязан быть
 * идемпотентным: повторный пересчёт не удваивает числа и не плодит строки, а совпадение
 * «отпечатка» сырых данных вообще не переписывает таблицу.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

if (!/test/i.test(TEST_DB_URL)) {
  throw new Error("Тесты чистят таблицы, поэтому база обязана быть тестовой, а не " + TEST_DB_URL);
}

const U = "u-exec";
const CLERK = "u-clerk";
const SIGNER = "u-signer";

let dir = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

const SHARED_TABLES =
  "user_activity_stats, user_activity_stats_monthly, notifications, notification_templates, mail_sort_rules, " +
  "audit_log, resolution_assignees, resolution_approvals, resolutions, document_emails, documents, " +
  "number_counters, number_archives, settings, sessions, user_roles, users RESTART IDENTITY CASCADE";

async function cleanupSharedDb(): Promise<void> {
  await sql("TRUNCATE " + SHARED_TABLES);
}

async function insertUser(id: string, fullName: string, department = ""): Promise<void> {
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO users (id, email, full_name, department, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
    [id, id + "@stand.test", fullName, department, ts]
  );
}

async function insertDocument(opts: {
  id: string;
  sender: string;
  regDate: string;
  createdBy?: string | null;
  emailId?: string | null;
}): Promise<void> {
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO documents (id, reg_number, reg_number_numeric, reg_period, reg_date, sender, summary, " +
      "created_by, email_id, created_at, updated_at) VALUES ($1,$1,1,$2,$3,$4,'кратко',$5,$6,$7,$7)",
    [opts.id, opts.regDate.slice(0, 4), opts.regDate, opts.sender, opts.createdBy ?? null, opts.emailId ?? null, ts]
  );
}

async function insertResolution(opts: {
  id: string;
  documentId: string;
  status?: string;
  preparedBy?: string | null;
  approvedBy?: string | null;
  dispatchedBy?: string | null;
  dispatchedAt?: string | null;
  deadline?: string | null;
  createdAt?: string;
}): Promise<void> {
  const ts = opts.createdAt ?? new Date().toISOString();
  await sql(
    "INSERT INTO resolutions (id, document_id, text, source_text, source_kind, status, priority, deadline, " +
      "prepared_by, approved_by, dispatched_by, dispatched_at, created_at, updated_at) " +
      "VALUES ($1,$2,'поручение','','manual',$3,'normal',$4,$5,$6,$7,$8,$9,$9)",
    [
      opts.id,
      opts.documentId,
      opts.status ?? "sent",
      opts.deadline ?? null,
      opts.preparedBy ?? null,
      opts.approvedBy ?? null,
      opts.dispatchedBy ?? null,
      opts.dispatchedAt ?? null,
      ts
    ]
  );
}

async function insertAssignee(resolutionId: string, userId: string, reportAt: string | null = null): Promise<void> {
  await sql(
    "INSERT INTO resolution_assignees (resolution_id, user_id, kind, report_at, created_at) VALUES ($1,$2,'responsible',$3,$4)",
    [resolutionId, userId, reportAt, new Date().toISOString()]
  );
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-stats-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  setUserStatsMailFactsProvider(null);
  await cleanupSharedDb();
  // Уборка проверяется явно: снимешь TRUNCATE — упадёт здесь, а не в чужом файле.
  expect(await count("SELECT count(*)::int AS n FROM user_activity_stats")).toBe(0);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  setUserStatsMailFactsProvider(null);
  await cleanupSharedDb();
  await insertUser(U, "Мария Петрова", "Бухгалтерия");
  await insertUser(CLERK, "Авдеева Ю.Н.", "Аппарат");
  await insertUser(SIGNER, "Иванов И.И.", "Руководство");
});

describe("пересчёт из сырых данных", () => {
  test("считает письма, поручения, сроки, корреспондентов, авторов и месяцы", async () => {
    await insertDocument({ id: "d-aug", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U, emailId: "e-1" });
    await insertDocument({ id: "d-sep", sender: "АО «Ромашка»", regDate: "2026-09-03", createdBy: U, emailId: "e-2" });

    // Поручение 1: отчиталась за 4 дня.
    await insertResolution({
      id: "r-1",
      documentId: "d-aug",
      preparedBy: CLERK,
      approvedBy: SIGNER,
      dispatchedAt: "2026-08-11T10:00:00.000Z",
      deadline: "2026-08-20"
    });
    await insertAssignee("r-1", U, "2026-08-15T10:00:00.000Z");

    // Поручение 2: в работе (не отчиталась).
    await insertResolution({
      id: "r-2",
      documentId: "d-sep",
      preparedBy: CLERK,
      approvedBy: SIGNER,
      dispatchedAt: "2026-09-01T10:00:00.000Z",
      // Далёкое будущее: «в работе» не должно зависеть от даты прогона.
      deadline: "2030-01-15"
    });
    await insertAssignee("r-2", U, null);

    // Поручение 3: просрочено (срок в прошлом, отчёта нет).
    await insertResolution({
      id: "r-3",
      documentId: "d-sep",
      preparedBy: CLERK,
      approvedBy: SIGNER,
      dispatchedAt: "2026-08-01T10:00:00.000Z",
      // Далёкое прошлое: просрочка тоже не должна зависеть от даты прогона.
      deadline: "2020-01-01"
    });
    await insertAssignee("r-3", U, null);

    // Роли самого пользователя в процессе.
    await insertResolution({ id: "r-p", documentId: "d-aug", preparedBy: U, status: "draft" });
    await insertResolution({ id: "r-a", documentId: "d-aug", approvedBy: U, status: "approved" });
    await insertResolution({ id: "r-d", documentId: "d-aug", dispatchedBy: U, status: "sent" });

    const result = await recomputeUserStats({ userIds: [U] });
    expect(result).toMatchObject({ users: 1, updated: 1, skipped: 0 });

    const page = await listUserActivityStats({ userId: U });
    expect(page.total).toBe(1);
    const row = page.items[0];
    expect(row).toMatchObject({
      userId: U,
      fullName: "Мария Петрова",
      department: "Бухгалтерия",
      documentsRegistered: 2,
      tasksAssigned: 3,
      tasksReported: 1,
      tasksOpen: 2,
      tasksOverdue: 1,
      resolutionsPrepared: 1,
      resolutionsApproved: 1,
      resolutionsDispatched: 1
    });
    expect(row.avgExecutionDays).toBe(4);
    // Два УНИКАЛЬНЫХ письма: поручение r-3 ссылается на то же письмо, что и r-2 — без дублей.
    expect(row.correspondenceOrgs).toEqual([{ name: "АО «Ромашка»", count: 2 }]);
    // Автор поручений — аппарат (подразделение пустое = «нет данных», не выдумываем).
    expect(row.authors).toEqual([{ userId: CLERK, name: "Авдеева Ю.Н.", count: 3 }]);
    expect(row.requestDepartments).toEqual([{ department: "Аппарат", count: 3 }]);

    // Месяцы: письма по дате регистрации, поручения — по дате выдачи.
    const months = Object.fromEntries(row.months.map((m) => [m.period, m]));
    expect(Object.keys(months).sort()).toEqual(["2026-08", "2026-09"]);
    expect(months["2026-08"]).toMatchObject({ documentsRegistered: 1, tasksAssigned: 2, tasksReported: 1 });
    expect(months["2026-09"]).toMatchObject({ documentsRegistered: 1, tasksAssigned: 1, tasksReported: 0 });
  });

  test("одно письмо с несколькими поручениями считается в топах ОДИН раз", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", emailId: "e-1" });
    await insertResolution({ id: "r-1", documentId: "d-1", preparedBy: CLERK, dispatchedAt: "2026-08-11T10:00:00.000Z" });
    await insertResolution({ id: "r-2", documentId: "d-1", preparedBy: CLERK, dispatchedAt: "2026-08-12T10:00:00.000Z" });
    await insertAssignee("r-1", U, null);
    await insertAssignee("r-2", U, null);
    setUserStatsMailFactsProvider(() => new Map([["e-1", { tags: ["договор"], categories: ["work"] }]]));

    await recomputeUserStats({ userIds: [U] });

    const row = (await listUserActivityStats({ userId: U })).items[0];
    expect(row.tasksAssigned).toBe(2);
    expect(row.correspondenceOrgs).toEqual([{ name: "АО «Ромашка»", count: 1 }]);
    expect(row.topTags).toEqual([{ value: "договор", count: 1 }]);
    expect(row.topCategories).toEqual([{ value: "work", count: 1 }]);
  });

  test("приватность: в агрегате только счётчики и топы, без текстов писем и адресов", async () => {
    await insertDocument({ id: "d-aug", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U, emailId: "e-1" });
    await recomputeUserStats({ userIds: [U] });

    const page = await listUserActivityStats({ userId: U });
    const asText = JSON.stringify(page);
    expect(asText).not.toContain("кратко"); // текст summary в агрегат не попадает
    expect(asText).not.toContain("@stand.test"); // адреса тоже
  });
});

describe("идемпотентность", () => {
  test("повторный пересчёт без изменений ничего не переписывает", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U });
    await insertResolution({ id: "r-1", documentId: "d-1", preparedBy: CLERK, dispatchedAt: "2026-08-11T10:00:00.000Z" });
    await insertAssignee("r-1", U, "2026-08-15T10:00:00.000Z");

    const first = await recomputeUserStats({ userIds: [U] });
    expect(first).toMatchObject({ users: 1, updated: 1, skipped: 0 });
    const before = (await listUserActivityStats({ userId: U })).items[0];

    const second = await recomputeUserStats({ userIds: [U] });
    expect(second).toMatchObject({ users: 1, updated: 0, skipped: 1 });

    const after = (await listUserActivityStats({ userId: U })).items[0];
    expect(after.tasksAssigned).toBe(before.tasksAssigned);
    expect(after.computedAt).toBe(before.computedAt); // не переписывали вообще
    expect(await count("SELECT count(*)::int AS n FROM user_activity_stats")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM user_activity_stats_monthly")).toBe(1);
  });

  test("изменение сырых данных пересчитывает: числа меняются, строки не удваиваются", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U });
    await insertResolution({ id: "r-1", documentId: "d-1", preparedBy: CLERK, dispatchedAt: "2026-08-11T10:00:00.000Z" });
    await insertAssignee("r-1", U, null);
    await recomputeUserStats({ userIds: [U] });

    await insertResolution({ id: "r-2", documentId: "d-1", preparedBy: CLERK, dispatchedAt: "2026-08-20T10:00:00.000Z" });
    await insertAssignee("r-2", U, null);

    const again = await recomputeUserStats({ userIds: [U] });
    expect(again).toMatchObject({ updated: 1, skipped: 0 });
    expect((await listUserActivityStats({ userId: U })).items[0].tasksAssigned).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM user_activity_stats")).toBe(1);
  });

  test("пересчёт всех пользователей берёт только тех, у кого есть активность", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U });

    const result = await recomputeUserStats();

    expect(result.users).toBe(1); // SIGNER и CLERK нигде не участвуют
    expect(await count("SELECT count(*)::int AS n FROM user_activity_stats")).toBe(1);
  });

  test("пустые данные не ломают: нули и пустые топы", async () => {
    const result = await recomputeUserStats({ userIds: [U] });

    expect(result).toMatchObject({ users: 1, updated: 1 });
    const row = (await listUserActivityStats({ userId: U })).items[0];
    expect(row).toMatchObject({ documentsRegistered: 0, tasksAssigned: 0, tasksOverdue: 0, avgExecutionDays: null });
    expect(row.correspondenceOrgs).toEqual([]);
    expect(row.months).toEqual([]);
  });
});

describe("теги и категории: только через провайдера почты", () => {
  test("без провайдера топы пусты, счётчики считаются", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U, emailId: "e-1" });
    await recomputeUserStats({ userIds: [U] });

    const row = (await listUserActivityStats({ userId: U })).items[0];
    expect(row.topTags).toEqual([]);
    expect(row.topCategories).toEqual([]);
    expect(row.documentsRegistered).toBe(1);
  });

  test("провайдер отдаёт теги и категории по списку писем", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U, emailId: "e-1" });
    await insertDocument({ id: "d-2", sender: "АО «Ромашка»", regDate: "2026-09-10", createdBy: U, emailId: "e-2" });
    const asked: string[][] = [];
    setUserStatsMailFactsProvider(async (emailIds) => {
      asked.push(emailIds);
      return new Map([
        ["e-1", { tags: ["договор", "срочно"], categories: ["work"] }],
        ["e-2", { tags: ["договор"], categories: ["work"] }]
      ]);
    });

    await recomputeUserStats({ userIds: [U] });

    const row = (await listUserActivityStats({ userId: U })).items[0];
    expect(row.topTags).toEqual([
      { value: "договор", count: 2 },
      { value: "срочно", count: 1 }
    ]);
    expect(row.topCategories).toEqual([{ value: "work", count: 2 }]);
    // Провайдер зовут ОДНИМ пакетным вызовом на весь пересчёт.
    expect(asked).toHaveLength(1);
    expect([...asked[0]].sort()).toEqual(["e-1", "e-2"]);
  });

  test("ошибка провайдера не роняет пересчёт — теги пустые, счётчики на месте", async () => {
    await insertDocument({ id: "d-1", sender: "АО «Ромашка»", regDate: "2026-08-10", createdBy: U, emailId: "e-1" });
    setUserStatsMailFactsProvider(async () => {
      throw new Error("почтовая база недоступна");
    });

    const result = await recomputeUserStats({ userIds: [U] });

    expect(result.updated).toBe(1);
    const row = (await listUserActivityStats({ userId: U })).items[0];
    expect(row.topTags).toEqual([]);
    expect(row.documentsRegistered).toBe(1);
  });
});
