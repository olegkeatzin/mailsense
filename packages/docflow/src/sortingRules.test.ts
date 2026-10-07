import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import type { Actor } from "./journal.js";
import { deleteSortRule, getSortRule, listSortRules, saveSortRule, setSortRuleValidator } from "./sortingRules.js";
// Настоящая проверка правил — из ядра: в пакете docflow barrel @mailsense/core не смонтирован,
// берём модуль по исходнику. Мок здесь был бы проверкой мока, а не границ §5.
import { validateSortRule } from "../../core/src/services/mailSortRules.js";

/**
 * Хранилище правил автосортировки (этап 5, §2/§6 контракта).
 *
 * Два свойства, ради которых это отдельный модуль:
 *   • правило НИЧЕГО не создаёт: ни документа, ни номера. Документ по-прежнему создаёт
 *     человек — правило только помечает письмо и поднимает его в очереди;
 *   • мутация правила и её след в аудите — ОДНА транзакция (AGENTS.md, п. 4).
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

let dir = "";

async function sql(query: string, params: unknown[] = []): Promise<void> {
  await getDocflowPool().query(query, params);
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(query, params);
  return Number(rows.rows[0]?.n ?? 0);
}

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-sorting-"));
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
  await setSortRuleValidator(null);
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
    "TRUNCATE mail_sort_rules, notifications, notification_templates, audit_log, resolution_assignees, " +
      "resolution_approvals, resolutions, document_emails, documents, number_counters, number_archives, " +
      "settings, sessions, user_roles, users RESTART IDENTITY CASCADE"
  );
});

afterEach(async () => {
  await unblockAudit();
});

const rule = (patch: Record<string, unknown> = {}) => ({
  name: "Письма от поставщика",
  matchFrom: "поставщик",
  matchSubject: "договор",
  label: "Договор",
  priority: 4,
  note: "Проверить срок поставки",
  sortOrder: 10,
  ...patch
});

describe("список правил", () => {
  test("пустой список — законное состояние: дефолтных правил мы не выдумываем", async () => {
    expect(await listSortRules()).toEqual([]);
  });

  test("порядок применения: sortOrder ASC, затем id", async () => {
    const second = await saveSortRule(rule({ sortOrder: 20, name: "Второе" }), actor);
    const first = await saveSortRule(rule({ sortOrder: 10, name: "Первое" }), actor);
    const firstToo = await saveSortRule(rule({ sortOrder: 10, name: "Тоже первое" }), actor);

    // При равном sortOrder порядок задаёт id — значит применение детерминировано.
    const sameOrder = [first.id, firstToo.id].sort();
    expect((await listSortRules()).map((r) => r.id)).toEqual([...sameOrder, second.id]);
  });
});

describe("создание, правка, удаление — со следом в той же транзакции", () => {
  test("правило создаётся со всеми полями и следом аудита", async () => {
    const created = await saveSortRule(rule(), actor);

    expect(created).toMatchObject({
      name: "Письма от поставщика",
      matchFrom: "поставщик",
      matchTo: "",
      matchSubject: "договор",
      label: "Договор",
      priority: 4,
      note: "Проверить срок поставки",
      sortOrder: 10,
      isActive: true
    });
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'sorting.rule.create'")).toBe(1);
    const audit = await getDocflowPool().query<{ entity_id: string; new_value: string }>(
      "SELECT entity_id, new_value FROM audit_log WHERE action = 'sorting.rule.create'"
    );
    expect(audit.rows[0].entity_id).toBe(created.id);
    expect(audit.rows[0].new_value).toContain("поставщик");
  });

  test("правило не создаёт документ и не тратит номер", async () => {
    await saveSortRule(rule(), actor);
    expect(await count("SELECT count(*)::int AS n FROM documents")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM number_counters")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM resolutions")).toBe(0);
  });

  test("сбой аудита откатывает создание правила", async () => {
    await blockAudit();
    await expect(saveSortRule(rule(), actor)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
  });

  test("правка меняет поля и пишет «было/стало»", async () => {
    const created = await saveSortRule(rule(), actor);
    const updated = await saveSortRule(
      { id: created.id, name: "Письма от поставщика (важные)", matchFrom: "поставщик", label: "Важное", priority: null, isActive: false },
      actor
    );

    expect(updated).toMatchObject({ id: created.id, label: "Важное", priority: null, isActive: false });
    const audit = await getDocflowPool().query<{ old_value: string; new_value: string }>(
      "SELECT old_value, new_value FROM audit_log WHERE action = 'sorting.rule.update'"
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].old_value).toContain("Договор");
    expect(audit.rows[0].new_value).toContain("Важное");
  });

  test("сбой аудита откатывает правку: правило остаётся прежним", async () => {
    const created = await saveSortRule(rule(), actor);
    await blockAudit();
    await expect(
      saveSortRule({ id: created.id, name: "Подмена", matchFrom: "поставщик" }, actor)
    ).rejects.toThrow();
    expect((await getSortRule(created.id))!.name).toBe("Письма от поставщика");
  });

  test("правка несуществующего правила — 404", async () => {
    await expect(saveSortRule({ id: "нет-такого", name: "Правило", matchFrom: "x" }, actor)).rejects.toMatchObject({
      status: 404
    });
  });

  test("пустое имя отклоняется: правило без имени не отличить в списке", async () => {
    await expect(saveSortRule({ name: "   " }, actor)).rejects.toMatchObject({ status: 400, code: "bad_name" });
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });

  test("удаление убирает правило и пишет след; сбой аудита его сохраняет", async () => {
    const created = await saveSortRule(rule(), actor);
    expect(await deleteSortRule(created.id, actor)).toBe(true);
    expect(await listSortRules()).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'sorting.rule.delete'")).toBe(1);

    const second = await saveSortRule(rule({ name: "Второе правило" }), actor);
    await blockAudit();
    await expect(deleteSortRule(second.id, actor)).rejects.toThrow();
    expect(await getSortRule(second.id)).not.toBeNull();
  });

  test("удаление несуществующего правила — false, без следа", async () => {
    expect(await deleteSortRule("нет-такого", actor)).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });
});

describe("границы §5 проверяются в САМОМ хранилище, а не только на маршруте", () => {
  afterEach(() => setSortRuleValidator(null));

  test("без зарегистрированной проверки хранилище сохраняет правило (проверяет вызывающий)", async () => {
    setSortRuleValidator(null);
    const saved = await saveSortRule(rule({ matchFrom: "x".repeat(5000) }), actor);
    expect(saved.id).toBeTruthy();
  });

  test("матчер в 5 КБ не сохраняется, когда проверка зарегистрирована", async () => {
    setSortRuleValidator(validateSortRule);
    await expect(saveSortRule(rule({ matchFrom: "x".repeat(5000) }), actor)).rejects.toMatchObject({
      status: 400,
      code: "bad_rule"
    });
    expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(0);
  });

  test("приоритет вне 1..5 не сохраняется", async () => {
    setSortRuleValidator(validateSortRule);
    for (const priority of [0, 6, 99, -1]) {
      await expect(saveSortRule(rule({ priority }), actor)).rejects.toMatchObject({ status: 400, code: "bad_rule" });
    }
    expect(await count("SELECT count(*)::int AS n FROM mail_sort_rules")).toBe(0);
  });

  test("снятие последнего матчера не проходит и через прямую правку хранилища", async () => {
    setSortRuleValidator(validateSortRule);
    const created = await saveSortRule(rule(), actor);
    await expect(
      saveSortRule({ id: created.id, matchFrom: "", matchTo: "", matchSubject: "" }, actor)
    ).rejects.toMatchObject({ status: 400, code: "bad_rule" });
    // Правило осталось прежним: проверка идёт до записи.
    expect((await getSortRule(created.id))!.matchFrom).toBe("поставщик");
  });
});
