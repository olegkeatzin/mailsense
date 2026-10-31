import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import {
  archivePeriod,
  documentStatusCounts,
  ensureCorrespondent,
  findDuplicates,
  getDocument,
  getDocumentByEmail,
  getNumberingState,
  linkDocumentEmail,
  listCases,
  listCorrespondents,
  listAudit,
  listDocuments,
  listDocumentsForExport,
  listNumberingRules,
  peekNextNumber,
  registerDocument,
  saveCase,
  saveNumberingRule,
  updateDocument,
  type Actor
} from "./index.js";

/**
 * Журнал регистрации входящих. Главное здесь — нумерация: она обязана быть
 * атомарной (ТЗ п. 7) и не открывать новый год, пока предыдущий не в архиве.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";


// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
// Раньше здесь был фолбэк на DOCFLOW_DATABASE_URL — рабочую переменную стенда: один
// `make test` на машине с ней вычищал пользователей, сессии, настройки и append-only аудит.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const actor: Actor = { id: null, name: "Тестовый секретарь" };
let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-journal-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
  // Миграции v2 и v3 должны быть применены — иначе тесты бессмысленны.
  const check = await getDocflowPool().query(
    "SELECT to_regclass('public.documents') AS d, to_regclass('public.resolutions') AS r, " +
      "to_regclass('public.resolution_assignees') AS ra, to_regclass('public.resolution_approvals') AS rap"
  );
  const t = check.rows[0] as { d: string | null; r: string | null; ra: string | null; rap: string | null };
  if (!t.d) throw new Error("Таблица documents не создана — миграция v2 не применилась");
  if (!t.r || !t.ra || !t.rap) {
    throw new Error("Таблицы резолюций не созданы — миграция v3 не применилась");
  }
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
  // Журнал чистим полностью: тесты не должны зависеть друг от друга.
  // audit_log чистим ТОЛЬКО в тестах: в работе это append-only журнал следов,
  // его нельзя ни очищать, ни править — иначе «найти виноватого» не выйдет.
  await getDocflowPool().query(
    "TRUNCATE documents, document_emails, number_counters, number_archives, case_nomenclature, correspondents, audit_log RESTART IDENTITY CASCADE"
  );
  // Правила нумерации тоже возвращаем к исходным: иначе тест, меняющий
  // префикс, «протекает» в следующие и они падают на ровном месте.
  await getDocflowPool().query("DELETE FROM number_rules");
  await getDocflowPool().query(
    "INSERT INTO number_rules (stream, prefix, reset, template) VALUES ('incoming', 'вх', 'year', NULL), ('outgoing', 'исх', 'year', NULL)"
  );
});

describe("нумерация", () => {
  test("первый документ получает «вх1»", async () => {
    const doc = await registerDocument({ summary: "Первый" }, actor);
    expect(doc.regNumber).toBe("вх1");
    expect(doc.regNumberNumeric).toBe(1);
    expect(doc.status).toBe("new");
  });

  test("номера идут по порядку и без ведущих нулей", async () => {
    const nums: string[] = [];
    for (let i = 0; i < 12; i++) nums.push((await registerDocument({ summary: "Док " + i }, actor)).regNumber);
    expect(nums[0]).toBe("вх1");
    expect(nums[9]).toBe("вх10");
    expect(nums[11]).toBe("вх12");
  });

  test("одновременные регистрации получают разные номера", async () => {
    // ТЗ п. 7: генерация номера должна быть атомарной — иначе два секретаря
    // получат один номер и документы будет не различить.
    const docs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerDocument({ summary: "Параллельный " + i }, actor))
    );
    const numbers = docs.map((d) => d.regNumber);
    expect(new Set(numbers).size).toBe(8);
    expect([...numbers].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))).toEqual([
      "вх1", "вх2", "вх3", "вх4", "вх5", "вх6", "вх7", "вх8"
    ]);
  });

  test("в новом году счётчик начинается заново", async () => {
    await registerDocument({ summary: "Старый год", regDate: "2026-12-20" }, actor);
    await archivePeriod({ period: "2026" }, actor);
    const next = await registerDocument({ summary: "Новый год", regDate: "2027-01-05" }, actor);
    expect(next.regNumber).toBe("вх1");
    expect(next.regPeriod).toBe("2027");
  });

  test("номер уникален в пределах года, а не глобально", async () => {
    const a = await registerDocument({ summary: "A", regDate: "2026-01-10" }, actor);
    // Документ задним числом в тот же год продолжает нумерацию.
    const b = await registerDocument({ summary: "B", regDate: "2026-02-10" }, actor);
    expect(a.regNumber).toBe("вх1");
    expect(b.regNumber).toBe("вх2");
    expect(b.regPeriod).toBe("2026");
  });

  test("правила нумерации по умолчанию — вх/исх со сбросом по годам", async () => {
    const rules = await listNumberingRules();
    const incoming = rules.find((r) => r.stream === "incoming")!;
    expect(incoming.prefix).toBe("вх");
    expect(incoming.reset).toBe("year");
  });

  test("префикс из настроек применяется к новым номерам", async () => {
    await saveNumberingRule({ stream: "incoming", prefix: "ВХ-", reset: "year", template: "{prefix}{n}" }, actor);
    const doc = await registerDocument({ summary: "С префиксом" }, actor);
    expect(doc.regNumber).toBe("ВХ-1");
  });

  test("шаблон номера с годом работает", async () => {
    await saveNumberingRule({ stream: "incoming", prefix: "вх", reset: "year", template: "{prefix}-{year}-{n}" }, actor);
    const doc = await registerDocument({ summary: "По шаблону", regDate: "2026-03-03" }, actor);
    expect(doc.regNumber).toBe("вх-2026-1");
  });

  test("префикс и шаблон нельзя менять, когда год уже начат", async () => {
    await registerDocument({ summary: "Первый документ года" }, actor);
    // Иначе в одном журнале окажутся «вх1» и «ВХ-2», и он перестанет сходиться с бумажным.
    await expect(
      saveNumberingRule({ stream: "incoming", prefix: "ВХ-", reset: "year", template: null }, actor)
    ).rejects.toThrow(/менять нельзя/);
    await expect(
      saveNumberingRule({ stream: "incoming", prefix: "вх", reset: "year", template: "{prefix}-{n}" }, actor)
    ).rejects.toThrow(/менять нельзя/);
  });

  test("смена периодичности сброса не блокируется начатым годом", async () => {
    await registerDocument({ summary: "Первый документ года" }, actor);
    // Сброс влияет на будущие периоды, уже выданные номера не трогает.
    await expect(
      saveNumberingRule({ stream: "incoming", prefix: "вх", reset: "never", template: null }, actor)
    ).resolves.toBeTruthy();
  });

  test("в пустом журнале правило меняется свободно", async () => {
    await expect(
      saveNumberingRule({ stream: "incoming", prefix: "ВХ-", reset: "year", template: "{prefix}{n}" }, actor)
    ).resolves.toBeTruthy();
  });
});

describe("закрытие года", () => {
  test("новый год не открывается, пока прошлый не выгружен", async () => {
    await registerDocument({ summary: "Документ 2026", regDate: "2026-12-31" }, actor);
    await expect(registerDocument({ summary: "Документ 2027", regDate: "2027-01-01" }, actor)).rejects.toThrow(
      /не выгружен в архив/
    );
  });

  test("после выгрузки года новый открывается", async () => {
    await registerDocument({ summary: "Документ 2026", regDate: "2026-05-05" }, actor);
    await archivePeriod({ period: "2026", fileName: "журнал-2026.xlsx", documentCount: 1 }, actor);
    await expect(registerDocument({ summary: "Документ 2027", regDate: "2027-02-02" }, actor)).resolves.toBeTruthy();
  });

  test("пустой журнал открывает любой год", async () => {
    const doc = await registerDocument({ summary: "Первый в 2030", regDate: "2030-06-06" }, actor);
    expect(doc.regPeriod).toBe("2030");
  });

  test("состояние нумерации показывает открытый год и причину блокировки", async () => {
    await registerDocument({ summary: "Документ", regDate: "2026-01-01" }, actor);
    const state = await getNumberingState("2027");
    expect(state.openPeriod).toBe("2026");
    expect(state.blockedReason).toMatch(/не выгружен в архив/);
    const same = await getNumberingState("2026");
    expect(same.blockedReason).toBeNull();
  });
});

describe("повторная регистрация письма", () => {
  test("то же письмо дважды не регистрируется", async () => {
    await registerDocument({ summary: "Письмо", emailId: "email-1" }, actor);
    await expect(registerDocument({ summary: "Письмо", emailId: "email-1" }, actor)).rejects.toThrow(
      /уже зарегистрировано/
    );
  });

  test("неудачная попытка не съедает номер", async () => {
    const first = await registerDocument({ summary: "Письмо", emailId: "email-1" }, actor);
    expect(first.regNumber).toBe("вх1");
    await registerDocument({ summary: "Письмо", emailId: "email-1" }, actor).catch(() => undefined);
    // Следующий документ обязан получить «вх2», а не «вх3».
    const second = await registerDocument({ summary: "Другое" }, actor);
    expect(second.regNumber).toBe("вх2");
  });

  test("документ находится по письму-источнику", async () => {
    const doc = await registerDocument({ summary: "С письмом", emailId: "email-42" }, actor);
    expect((await getDocumentByEmail("email-42"))!.id).toBe(doc.id);
    expect(await getDocumentByEmail("нет-такого")).toBeNull();
  });
});

describe("поиск дублей", () => {
  test("письмо, уже зарегистрированное, находится по email", async () => {
    const doc = await registerDocument({ summary: "Уже в журнале", emailId: "email-dup" }, actor);
    const dups = await findDuplicates({ emailId: "email-dup" });
    expect(dups).toHaveLength(1);
    expect(dups[0].reason).toBe("email");
    expect(dups[0].document.id).toBe(doc.id);
  });

  test("совпадение по номеру документа", async () => {
    await registerDocument({ summary: "Первый", docNumber: "3175/РТ" }, actor);
    const dups = await findDuplicates({ docNumber: "3175/РТ" });
    expect(dups.some((d) => d.reason === "docNumber")).toBe(true);
  });

  test("короткие темы не считаются дублями", async () => {
    await registerDocument({ summary: "Привет" }, actor);
    // Иначе половина журнала «дублировала» бы друг друга по слову «письмо».
    expect(await findDuplicates({ summary: "Привет" })).toHaveLength(0);
  });

  test("содержательное совпадение по теме находится", async () => {
    await registerDocument({ summary: "Материалы к ВКС по исх. 3175" }, actor);
    const dups = await findDuplicates({ summary: "Материалы к ВКС по исх. 3175" });
    expect(dups.some((d) => d.reason === "summary")).toBe(true);
  });

  test("один документ не дублируется в списке", async () => {
    await registerDocument({ summary: "Длинное содержание документа", docNumber: "42" }, actor);
    const dups = await findDuplicates({ docNumber: "42", summary: "Длинное содержание документа" });
    expect(dups).toHaveLength(1);
  });

  test("чистый журнал не даёт дублей", async () => {
    expect(await findDuplicates({ emailId: "x", docNumber: "y", summary: "достаточно длинная тема" })).toEqual([]);
  });
});

describe("журнал: список и фильтры", () => {
  beforeEach(async () => {
    await registerDocument(
      { summary: "Материалы к ВКС", sender: "ООО «Партнёр»", docNumber: "3175", docDate: "2026-08-31", regDate: "2026-09-01" },
      actor
    );
    await registerDocument(
      { summary: "Акт выполненных работ", sender: "АО «Клиент»", docNumber: "44", regDate: "2026-09-15" },
      actor
    );
    await registerDocument(
      { summary: "Счёт на оплату", sender: "ООО «Поставщик»", regDate: "2026-10-01" },
      actor
    );
  });

  test("возвращаются все документы с общим количеством", async () => {
    const page = await listDocuments({});
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    expect(page.items[0].createdByName).toBe("");
  });

  test("сортировка по номеру идёт численно, а не по алфавиту", async () => {
    for (let i = 0; i < 9; i++) await registerDocument({ summary: "Ещё " + i }, actor);
    const asc = await listDocuments({ sort: "regNumber", order: "asc", limit: 3 });
    // «вх10» должно быть после «вх9», иначе журнал читается неправильно.
    expect(asc.items.map((d) => d.regNumber)).toEqual(["вх1", "вх2", "вх3"]);
    const desc = await listDocuments({ sort: "regNumber", order: "desc", limit: 1 });
    expect(desc.items[0].regNumber).toBe("вх12");
  });

  test("поиск находит по содержанию на кириллице в любом регистре", async () => {
    const page = await listDocuments({ search: "вкс" });
    expect(page.total).toBe(1);
    expect(page.items[0].summary).toContain("ВКС");
  });

  test("поиск идёт и по отправителю, и по номеру документа", async () => {
    expect((await listDocuments({ search: "партнёр" })).total).toBe(1);
    expect((await listDocuments({ search: "3175" })).total).toBe(1);
  });

  test("фильтр по диапазону дат регистрации", async () => {
    const page = await listDocuments({ dateFrom: "2026-09-10", dateTo: "2026-09-30" });
    expect(page.total).toBe(1);
    expect(page.items[0].summary).toContain("Акт");
  });

  test("фильтр по статусу", async () => {
    expect((await listDocuments({ status: "new" })).total).toBe(3);
    expect((await listDocuments({ status: "archived" })).total).toBe(0);
  });

  test("фильтр по периоду", async () => {
    expect((await listDocuments({ period: "2026" })).total).toBe(3);
    expect((await listDocuments({ period: "2025" })).total).toBe(0);
  });

  test("постраничность не теряет и не повторяет записи", async () => {
    const first = await listDocuments({ limit: 2, offset: 0, sort: "regNumber", order: "asc" });
    const second = await listDocuments({ limit: 2, offset: 2, sort: "regNumber", order: "asc" });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((d) => d.id)).size).toBe(3);
  });

  test("выгрузка берёт все страницы, а не только первую", async () => {
    const all = await listDocumentsForExport({});
    expect(all).toHaveLength(3);
  });

  test("сводка по статусам считается", async () => {
    const counts = await documentStatusCounts();
    expect(counts.new).toBe(3);
  });
});

describe("карточка документа", () => {
  test("правка полей сохраняется", async () => {
    const doc = await registerDocument({ summary: "Черновик" }, actor);
    const updated = await updateDocument(
      doc.id,
      { summary: "Уточнённое содержание", sheetsCount: 3, caseNumber: "01-15", docNumber: "99", sender: "АО «Тест»" },
      actor
    )!;
    expect(updated!.summary).toBe("Уточнённое содержание");
    expect(updated!.sheetsCount).toBe(3);
    expect(updated!.caseNumber).toBe("01-15");
    expect(updated!.docNumber).toBe("99");
  });

  test("номер и период при правке не меняются", async () => {
    const doc = await registerDocument({ summary: "Документ" }, actor);
    const updated = (await updateDocument(doc.id, { summary: "Другое" }, actor))!;
    // Номер — это то, что уже вписан в бумажный журнал: менять его нельзя.
    expect(updated.regNumber).toBe(doc.regNumber);
    expect(updated.regPeriod).toBe(doc.regPeriod);
  });

  test("статус переключается", async () => {
    const doc = await registerDocument({ summary: "Документ" }, actor);
    const updated = (await updateDocument(doc.id, { status: "on_resolution" }, actor))!;
    expect(updated.status).toBe("on_resolution");
  });

  test("правка несуществующего документа даёт null", async () => {
    expect(await updateDocument("нет-такого", { summary: "x" }, actor)).toBeNull();
  });

  test("карточка несуществующего документа даёт null", async () => {
    expect(await getDocument("нет-такого")).toBeNull();
  });

  test("некорректная дата регистрации не применяется", async () => {
    const doc = await registerDocument({ summary: "Документ" }, actor);
    const updated = (await updateDocument(doc.id, { regDate: "не дата" }, actor))!;
    expect(updated.regDate).toBe(doc.regDate);
  });
});

describe("прослеживаемость: кто и что сделал", () => {
  const secretary: Actor = { id: "user-1", name: "Петрова М.А." };

  test("регистрация записывается в аудит с автором и номером", async () => {
    const doc = await registerDocument({ summary: "Документ", sender: "АО «Тест»" }, secretary);
    const entries = await listAudit({ entityType: "document", entityId: doc.id });

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("journal.register");
    expect(entries[0].userName).toBe("Петрова М.А.");
    expect(entries[0].userId).toBe("user-1");
    expect(entries[0].newValue).toContain(doc.regNumber);
    expect(entries[0].createdAt).toBeTruthy();
  });

  test("корреспондент создаётся и связывается с документом по отправителю", async () => {
    const first = await registerDocument(
      { summary: "Первый", sender: "АО «Тест-Корр»", senderEmail: "Info@Test-Corr.ru" },
      secretary
    );
    expect(first.correspondentId).toBeTruthy();

    const rows = await getDocflowPool().query<{ id: string; name: string }>(
      "SELECT id, name FROM correspondents"
    );
    expect(rows.rows).toEqual([{ id: first.correspondentId, name: "АО «Тест-Корр»" }]);
    const mapped = await getDocflowPool().query<{ email: string }>(
      "SELECT email FROM correspondent_emails WHERE correspondent_id = $1",
      [first.correspondentId]
    );
    expect(mapped.rows).toEqual([{ email: "info@test-corr.ru" }]);

    const second = await registerDocument(
      { summary: "Второй", sender: "Другое имя", senderEmail: "info@test-corr.ru" },
      secretary
    );
    expect(second.correspondentId).toBe(first.correspondentId);
    expect(await getDocflowPool().query("SELECT 1 FROM correspondents")).toMatchObject({ rowCount: 1 });
  });

  test("в журнале видно, кто зарегистрировал документ", async () => {
    // ФИО автора подставляется в список — чтобы не открывать аудит ради этого.
    const db = getDocflowPool();
    await db.query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      ["user-1", "petrova@test.local", "Петрова М.А.", new Date().toISOString(), new Date().toISOString()]
    );
    const doc = await registerDocument({ summary: "Документ" }, secretary);
    const page = await listDocuments({ search: doc.regNumber });
    expect(page.items[0].createdByName).toBe("Петрова М.А.");
    await db.query("DELETE FROM users WHERE id = $1", ["user-1"]);
  });

  test("правка сохраняет и старое, и новое значение", async () => {
    const doc = await registerDocument({ summary: "Черновик", sheetsCount: 2 }, secretary);
    await updateDocument(doc.id, { summary: "Уточнено", sheetsCount: 5 }, secretary);

    const entries = await listAudit({ entityType: "document", entityId: doc.id, action: "journal.edit" });
    expect(entries).toHaveLength(1);
    // Именно разница «было → стало» показывает, что человек ввёл неверно.
    expect(entries[0].oldValue).toContain("Черновик");
    expect(entries[0].oldValue).toContain("2");
    expect(entries[0].newValue).toContain("Уточнено");
    expect(entries[0].newValue).toContain("5");
  });

  test("история правок накапливается по порядку", async () => {
    const doc = await registerDocument({ summary: "Документ" }, secretary);
    await updateDocument(doc.id, { sender: "Первый" }, secretary);
    await updateDocument(doc.id, { sender: "Второй" }, { id: "user-2", name: "Иванов И.И." });

    const entries = await listAudit({ entityType: "document", entityId: doc.id });
    // Свежие изменения — первыми, поэтому видно последнего, кто правил.
    expect(entries[0].userName).toBe("Иванов И.И.");
    expect(entries[1].userName).toBe("Петрова М.А.");
    expect(entries[2].action).toBe("journal.register");
  });

  test("неудачная попытка зарегистрировать дубль тоже фиксируется", async () => {
    await registerDocument({ summary: "Письмо", emailId: "email-1" }, secretary);
    await registerDocument({ summary: "Письмо", emailId: "email-1" }, secretary).catch(() => undefined);

    const denied = await listAudit({ action: "journal.register_denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0].userName).toBe("Петрова М.А.");
    expect(denied[0].newValue).toContain("duplicate_email");
  });

  test("отказ из-за закрытого периода тоже фиксируется", async () => {
    await registerDocument({ summary: "Документ 2026", regDate: "2026-12-31" }, secretary);
    await registerDocument({ summary: "Документ 2027", regDate: "2027-01-01" }, secretary).catch(() => undefined);

    const denied = await listAudit({ action: "journal.register_denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0].newValue).toContain("period_closed");
  });

  test("смена правила нумерации фиксируется с автором", async () => {
    await saveNumberingRule({ stream: "incoming", prefix: "ВХ-", reset: "year", template: null }, secretary);
    const entries = await listAudit({ action: "journal.numbering.save" });
    expect(entries).toHaveLength(1);
    expect(entries[0].userName).toBe("Петрова М.А.");
    expect(entries[0].newValue).toContain("ВХ-");
  });

  test("аудит фильтруется по автору", async () => {
    await registerDocument({ summary: "Первый" }, secretary);
    await registerDocument({ summary: "Второй" }, { id: "user-9", name: "Сидоров" });
    expect(await listAudit({ userId: "user-1" })).toHaveLength(1);
  });
});

describe("справочники", () => {
  test("номенклатура дел сохраняется и сортируется", async () => {
    await saveCase({ code: "02-10", title: "Переписка", sortOrder: 2 }, actor);
    await saveCase({ code: "01-15", title: "Входящие", sortOrder: 1 }, actor);
    const cases = await listCases();
    expect(cases.map((c) => c.code)).toEqual(["01-15", "02-10"]);
  });

  test("неактивные дела скрываются по фильтру", async () => {
    await saveCase({ code: "03-01", title: "Старое", isActive: false }, actor);
    expect(await listCases(true)).toHaveLength(0);
    expect(await listCases(false)).toHaveLength(1);
  });

  test("повторное сохранение дела не создаёт дубль", async () => {
    const c = await saveCase({ code: "01-15", title: "Входящие" }, actor);
    await saveCase({ id: c.id, code: "01-15", title: "Входящие документы" }, actor);
    const cases = await listCases();
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe("Входящие документы");
  });

  test("корреспондент создаётся один раз по имени", async () => {
    const a = await ensureCorrespondent("ООО «Партнёр»", actor);
    const b = await ensureCorrespondent("ООО «Партнёр»", actor);
    expect(a!.id).toBe(b!.id);
    expect(await listCorrespondents()).toHaveLength(1);
  });

  test("пустое имя не создаёт корреспондента", async () => {
    expect(await ensureCorrespondent("   ", actor)).toBeNull();
    expect(await listCorrespondents()).toHaveLength(0);
  });
});
describe("подсказка следующего номера", () => {
  test("подсказка не выдаёт номер и не двигает счётчик", async () => {
    // Иначе открытие формы съедало бы номер, и в журнале появились бы пропуски.
    const before = await peekNextNumber();
    const again = await peekNextNumber();
    expect(again.regNumber).toBe(before.regNumber);
  });

  test("подсказка совпадает с номером, который выдаст регистрация", async () => {
    const peeked = await peekNextNumber();
    const doc = await registerDocument({ emailId: "peek-1", summary: "Проверка подсказки" }, actor);
    expect(doc.regNumber).toBe(peeked.regNumber);
    // Следующая подсказка уже про следующий номер — счётчик сдвинула только регистрация.
    const next = await peekNextNumber();
    expect(next.regNumber).not.toBe(peeked.regNumber);
  });
});

describe("привязка письма к документу", () => {
  test("письмо — источник другого документа: отказ, а не ложный след", async () => {
    const first = await registerDocument({ emailId: "mail-dup", summary: "Первый" }, actor);
    const second = await registerDocument({ summary: "Второй" }, actor);
    const before = (await listAudit({ limit: 500 })).length;

    // Связи не будет (частичный индекс document_emails_source_idx: одно письмо —
    // источник ровно одного документа). Значит, не должно быть ни «ok»,
    // ни следа «связь создана»: ложный след в аудите — худший из исходов.
    await expect(linkDocumentEmail(second.id, "mail-dup", "source", actor)).rejects.toThrow(/источник/);

    const links = await getDocflowPool().query<{ document_id: string }>(
      "SELECT document_id FROM document_emails WHERE email_id = $1",
      ["mail-dup"]
    );
    expect(links.rows.map((r) => r.document_id)).toEqual([first.id]);
    expect((await listAudit({ limit: 500 })).length).toBe(before);
  });

  test("повторная привязка того же письма к тому же документу второго следа не пишет", async () => {
    const doc = await registerDocument({ emailId: "mail-same", summary: "Документ" }, actor);
    const before = (await listAudit({ limit: 500 })).length;

    // Ничего не изменилось — значит, и следа быть не должно.
    await linkDocumentEmail(doc.id, "mail-same", "source", actor);
    expect((await listAudit({ limit: 500 })).length).toBe(before);
  });

  test("новая связь пишет след", async () => {
    const doc = await registerDocument({ summary: "Документ" }, actor);
    await linkDocumentEmail(doc.id, "mail-new", "resolution", actor);

    const entries = (await listAudit({ limit: 500 })).filter((e) => e.action === "journal.link_email");
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe(doc.id);
  });
});