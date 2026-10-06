import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { archivePeriod, registerDocument, type Actor } from "./journal.js";
import {
  approveResolution,
  createResolution,
  dispatchResolution,
  markTaskReceived,
  reportExecution,
  requestApproval
} from "./resolutions.js";
import {
  exportJournalYear,
  exportPeriodArchive,
  importJournalArchive,
  setJournalAttachmentStore,
  type JournalAttachmentStore
} from "./journalArchive.js";
import { ZipReader, ZipWriter } from "./zipStream.js";

/**
 * Приёмка «журнал за год одним файлом»: выгрузка → импорт БЕЗ ПОТЕРЬ.
 *
 * Проверяем на НАСТОЯЩЕЙ базе: сверка идёт построчно по всем полям, а вложения —
 * байт в байт. Не «примерно совпало»: манифест со sha256, ключи первичные, порядок
 * детерминированный. Тест обязан уметь падать — это проверено подменой поля.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const PERIOD = "2026";
const secretary: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };
const director: Actor = { id: "u-signer", name: "Иванов И.И." };
const executorA: Actor = { id: "u-exec-a", name: "Романов Е.С." };

let root = "";
let attSrc = "";
let attDst = "";

const store: JournalAttachmentStore = {
  async list(emailId: string) {
    const dir = path.join(attSrc, emailId);
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    return names.map((name) => ({ name, open: () => createReadStream(path.join(dir, name)) }));
  }
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-archive-"));
  initCoreDb(path.join(root, "core"));
  await initDocflowDb(TEST_DB_URL);
  attSrc = path.join(root, "mail");
  attDst = path.join(root, "restored");
  await fs.promises.mkdir(path.join(attSrc, "mail-1"), { recursive: true });
  // Бинарный файл: нулевой байт и случайные байты — проверка «байт в байт», а не «текст похож».
  await fs.promises.writeFile(path.join(attSrc, "mail-1", "акт.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x7f, 0x00, 0x01]));
  await fs.promises.writeFile(path.join(attSrc, "mail-1", "смета.xlsx"), Buffer.from("PK\u0003\u0004бинарные данные", "binary"));
  setJournalAttachmentStore(store);
});

afterAll(async () => {
  setJournalAttachmentStore(null);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

/**
 * Принудительная сборка мусора: нужна только для честного замера живой памяти.
 * Без неё heapUsed показывает не задержавшееся, а просто не собранное.
 */
function forceGc(): () => void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v8 = require("node:v8") as typeof import("node:v8");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require("node:vm") as typeof import("node:vm");
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? gc : () => undefined;
  } catch {
    return () => undefined;
  }
}

/** Чистим ЖУРНАЛ, справочник оставляем: он не часть архива, а окружение. */
async function wipeJournal(): Promise<void> {
  await getDocflowPool().query(
    "TRUNCATE documents, document_emails, resolutions, resolution_assignees, resolution_approvals, " +
      "audit_log, number_counters, number_archives RESTART IDENTITY CASCADE"
  );
}

beforeEach(async () => {
  await wipeJournal();
  await fs.promises.rm(attDst, { recursive: true, force: true });
  const ts = new Date().toISOString();
  for (const u of [secretary, director, executorA]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, department, position, is_active, blocked, created_at, updated_at) " +
        "VALUES ($1,$2,$3,'Аппарат','Специалист',TRUE,FALSE,$4,$4) ON CONFLICT (id) DO NOTHING",
      [u.id, u.id + "@stand.test", u.name, ts]
    );
  }
});

/** Год журнала: два документа (с вложением и без), поручение с отчётом и распиской. */
async function seedYear(): Promise<void> {
  // ⚠️ Все поля заполнены РАЗНЫМИ значениями: на пустых значениях сверка «поле в поле»
  // проходит и при потерянном поле — тест был бы пустым (rules.md, п. 2.3).
  const first = await registerDocument(
    {
      emailId: "mail-1",
      summary: "Письмо о марафоне",
      sender: "АО «ОПК»",
      regDate: PERIOD + "-03-01",
      docNumber: "01-15/2026",
      docDate: PERIOD + "-02-20",
      sheetsCount: 3,
      caseNumber: "01-15",
      documentName: "Письмо о марафоне (вх. 1)"
    },
    secretary
  );
  await registerDocument(
    { summary: "Без вложений и поручений", regDate: PERIOD + "-04-02", docNumber: "777/2026", sheetsCount: 1 },
    secretary
  );

  const r = await createResolution(
    {
      documentId: first.id,
      text: "Подготовить заявку",
      sourceText: "ИИ предложил: подготовить заявку",
      sourceKind: "ai",
      priority: "important",
      deadline: PERIOD + "-06-01",
      assignees: [{ userId: executorA.id, kind: "responsible" }]
    },
    secretary
  );
  await requestApproval(r.id, secretary, { requestEmailId: "mail-request-1" });
  await approveResolution(r.id, director, {});
  await dispatchResolution(r.id, secretary, {});
  await markTaskReceived(r.id, executorA.id);
  await reportExecution(r.id, executorA.id, { text: "Заявка подготовлена" }, executorA);
  // Год закрыт: запись о закрытии — часть журнала, иначе после восстановления
  // неизвестно, что год уже закрывали.
  await archivePeriod({ period: PERIOD, fileName: "journal-" + PERIOD + ".zip", documentCount: 2 }, secretary);
}

const dump = async (): Promise<Record<string, unknown[]>> => {
  const q = async (sql: string) => (await getDocflowPool().query(sql)).rows as unknown[];
  return {
    // Справочник импорт трогать не должен: существующие пользователи остаются как есть.
    users: await q("SELECT * FROM users ORDER BY id"),
    documents: await q("SELECT * FROM documents ORDER BY reg_number_numeric, id"),
    resolutions: await q("SELECT * FROM resolutions ORDER BY id"),
    assignees: await q("SELECT * FROM resolution_assignees ORDER BY resolution_id, user_id"),
    approvals: await q("SELECT * FROM resolution_approvals ORDER BY id"),
    number_archives: await q("SELECT * FROM number_archives ORDER BY id"),
    audit: await q("SELECT * FROM audit_log WHERE action <> 'journal.import_year' ORDER BY id")
  };
};

async function exportTo(file: string): Promise<void> {
  const out = createWriteStream(file);
  await exportJournalYear({ year: PERIOD, out, attachments: store, pageSize: 25 });
  await new Promise<void>((resolve) => out.close(() => resolve()));
}

describe("выгрузка и импорт журнала за год", () => {
  test("1. импорт без потерь: поля построчно и вложения байт в байт", async () => {
    await seedYear();
    const zip = path.join(root, "journal.zip");
    const before = await dump();
    await exportTo(zip);

    // Манифест: версия формата и сумма каждого файла — часть формата, а не «на память».
    const reader = await ZipReader.open(zip);
    const manifest = JSON.parse((await reader.readAll("manifest.json")).toString("utf8"));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.period).toBe(PERIOD);
    expect(manifest.files.map((f: { name: string }) => f.name)).toContain("documents.jsonl");
    for (const f of manifest.files as Array<{ name: string; sha256: string }>) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    await wipeJournal();
    const res = await importJournalArchive({ file: zip, actor: secretary, attachmentsDir: attDst });

    // Главное: ЖУРНАЛ совпадает ПОЛНОСТЬЮ — все поля, все строки, ничего лишнего.
    // Сравниваем по таблицам: так падение сразу называет, ГДЕ потеря.
    const after = await dump();
    for (const table of Object.keys(before)) {
      expect([table, after[table]]).toEqual([table, before[table]]);
    }
    expect(res.inserted.documents).toBe(2);
    expect(res.attachments).toBe(2);

    // Вложения — байт в байт, включая нулевые байты.
    for (const name of ["акт.pdf", "смета.xlsx"]) {
      expect(await fs.promises.readFile(path.join(attDst, "mail-1", name))).toEqual(
        await fs.promises.readFile(path.join(attSrc, "mail-1", name))
      );
    }

    // Права из архива не восстанавливаются (см. комментарий в journalArchive.ts):
    // роли импортом не трогаются вообще.
    const roles = await getDocflowPool().query("SELECT count(*)::int AS n FROM user_roles");
    expect(Number(roles.rows[0].n)).toBe(0);
  });

  test("2. повторный импорт не дублирует: существующие строки пропускаются", async () => {
    await seedYear();
    const zip = path.join(root, "journal.zip");
    await exportTo(zip);
    await wipeJournal();

    const first = await importJournalArchive({ file: zip, actor: secretary, attachmentsDir: attDst });
    const was = await dump();
    const again = await importJournalArchive({ file: zip, actor: secretary, attachmentsDir: attDst });

    expect(again.inserted.documents).toBe(0);
    expect(again.skipped.documents).toBe(first.inserted.documents);
    expect(again.skipped.resolutions).toBe(first.inserted.resolutions);
    expect(await dump()).toEqual(was);
  });

  test("3. битый файл: импорт отклонён, база не тронута", async () => {
    await seedYear();
    const zip = path.join(root, "journal.zip");
    await exportTo(zip);
    await wipeJournal();

    const broken = path.join(root, "broken.zip");
    const buf = await fs.promises.readFile(zip);
    // Бьём байт ВНУТРИ данных записи: служебные области ZIP (data descriptor) читателю
    // не нужны, и порча в них ничего не докажет. Заголовок записи — 30 байт + имя.
    const entry = (await ZipReader.open(zip)).entry("documents.jsonl")!;
    const target = entry.localOffset + 30 + "documents.jsonl".length + 20;
    buf[target] = buf[target] ^ 0xff;
    await fs.promises.writeFile(broken, buf);

    await expect(importJournalArchive({ file: broken, actor: secretary, attachmentsDir: attDst })).rejects.toThrow(
      /повреждён|не читается/
    );
    const docs = await getDocflowPool().query("SELECT count(*)::int AS n FROM documents");
    expect(Number(docs.rows[0].n)).toBe(0);
  });

  test("4. чужой архив: версия формата и отсутствие файла — понятные ошибки", async () => {
    const foreign = path.join(root, "foreign.zip");
    const w = new ZipWriter(createWriteStream(foreign));
    const body = Buffer.from("", "utf8");
    const stats = [];
    for (const name of ["users.jsonl", "documents.jsonl", "resolutions.jsonl", "assignees.jsonl", "reports.jsonl", "audit.jsonl"]) {
      stats.push(await w.add(name, body));
    }
    await w.add(
      "manifest.json",
      Buffer.from(JSON.stringify({ formatVersion: 99, period: PERIOD, files: stats.map((s) => ({ name: s.name, size: s.size, sha256: s.sha256 })) }), "utf8")
    );
    await w.finish();
    await expect(importJournalArchive({ file: foreign, actor: secretary })).rejects.toThrow(/формата 99/);

    // Архив без обязательного файла.
    const incomplete = path.join(root, "incomplete.zip");
    const w2 = new ZipWriter(createWriteStream(incomplete));
    const s2 = [await w2.add("users.jsonl", body)];
    await w2.add(
      "manifest.json",
      Buffer.from(JSON.stringify({ formatVersion: 1, period: PERIOD, files: s2.map((s) => ({ name: s.name, size: s.size, sha256: s.sha256 })) }), "utf8")
    );
    await w2.finish();
    await expect(importJournalArchive({ file: incomplete, actor: secretary })).rejects.toThrow(/обязательных файлов/);
  });

  test("5. границы: пустой год выгружается и импортируется, документы без вложений не ломают", async () => {
    const emptyZip = path.join(root, "empty.zip");
    await exportTo(emptyZip);
    const res = await importJournalArchive({ file: emptyZip, actor: secretary, attachmentsDir: attDst });
    expect(res.inserted.documents).toBe(0);
    expect(res.period).toBe(PERIOD);

    // Документ без вложений и без поручений уже в seedYear: после импорта он на месте.
    await seedYear();
    const zip = path.join(root, "journal.zip");
    await exportTo(zip);
    await wipeJournal();
    await importJournalArchive({ file: zip, actor: secretary, attachmentsDir: attDst });
    const docs = await getDocflowPool().query<{ n: number }>("SELECT count(*)::int AS n FROM documents");
    expect(Number(docs.rows[0].n)).toBe(2);
  });

  test("6. память не растёт вместе с объёмом журнала", async () => {
    const peak = async (docs: number): Promise<number> => {
      await wipeJournal();
      const text = "я".repeat(4000);
      await getDocflowPool().query(
        "INSERT INTO documents (id, reg_number, reg_number_numeric, reg_period, reg_date, doc_number, doc_date, " +
          "sender, summary, sheets_count, case_number, document_name, status, email_id, correspondent_id, created_by, created_at, updated_at) " +
          "SELECT 'd-' || g, 'вх' || g, g, $1, $1 || '-03-01', '', NULL, 'Отправитель', $2, NULL, NULL, '', 'new', NULL, NULL, NULL, $1, $1 " +
          "FROM generate_series(1, $3) g",
        [PERIOD, text, docs]
      );
      const zip = path.join(root, "mem-" + docs + ".zip");
      // Меряем ЖИВОЙ набор: без принудительной сборки heapUsed показывает мусор
      // (аллокации между сборками), а не то, что архив реально держит в памяти.
      const gc = forceGc();
      gc();
      const base = process.memoryUsage().heapUsed;
      let highest = 0;
      const timer = setInterval(() => {
        gc();
        highest = Math.max(highest, process.memoryUsage().heapUsed - base);
      }, 100);
      try {
        await exportTo(zip);
      } finally {
        clearInterval(timer);
        gc();
        highest = Math.max(highest, process.memoryUsage().heapUsed - base);
      }
      return Math.max(highest, 0);
    };

    // 500 документов — около 2 МБ данных, 8000 — около 32 МБ. Если архив собирается
    // в памяти, пик вырастет примерно на объём добавленных данных; при потоковой
    // записи он остаётся ровным, и прирост тонет в шуме сборщика мусора.
    const small = await peak(500);
    const big = await peak(8000);
    const added = 7500 * 4000; // сколько данных добавилось
    console.log("пик памяти, МБ:", (small / 1048576).toFixed(1), "→", (big / 1048576).toFixed(1), "при +" + (added / 1048576).toFixed(0) + " МБ данных");

    expect(big - small).toBeLessThan(12 * 1024 * 1024); // прирост << добавленного объёма
    expect(big).toBeLessThan(96 * 1024 * 1024); // и никакого «архив целиком в памяти»
  }, 120000);

  test("8. снимок года ФАЙЛОМ: путь, имя и падение на неизвестном периоде (контракт для закрытия года)", async () => {
    await seedYear();
    const dir = path.join(root, "snapshots");
    const file = await exportPeriodArchive(PERIOD, path.join(dir, "snapshot.zip"));
    expect(file).toBe(path.join(dir, "snapshot.zip"));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(0);

    // Без dest файл ложится в каталог по умолчанию с детерминированным именем.
    const auto = await exportPeriodArchive(PERIOD);
    expect(path.basename(auto)).toMatch(new RegExp("^journal-" + PERIOD + "-\\d{8}-\\d{6}\\.zip$"));
    expect(fs.existsSync(auto)).toBe(true);
    await fs.promises.rm(auto, { force: true });

    // Негодный период — исключение (на нём закрытие года обязано отмениться).
    await expect(exportPeriodArchive("2026-й")).rejects.toThrow(/ГГГГ/);
  });

  test("7. история шагов поручения и запись о закрытии года восстанавливаются", async () => {
    // Без истории шагов восстановленный журнал не показывает, кто утвердил и когда
    // отправили, а без записи о закрытии год можно закрыть второй раз.
    await seedYear();
    const zip = path.join(root, "journal.zip");
    await exportTo(zip);
    const before = await dump();
    expect((before.approvals as unknown[]).length).toBeGreaterThanOrEqual(3); // запрошено, утверждено, отправлено
    expect((before.number_archives as unknown[]).length).toBe(1);

    await wipeJournal();
    await importJournalArchive({ file: zip, actor: secretary, attachmentsDir: attDst });

    const after = await dump();
    expect(after.approvals).toEqual(before.approvals);
    expect(after.number_archives).toEqual(before.number_archives);
  });
});
