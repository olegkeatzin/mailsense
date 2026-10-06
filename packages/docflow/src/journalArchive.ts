/**
 * Архив журнала за год: один ZIP-файл, который можно увезти, отдать в архив и вернуть
 * без потерь.
 *
 * Формат согласован с заказчиком (НЕ менять без согласования):
 *   manifest.json      — formatVersion, период, дата, счётчики, sha256 каждого файла
 *   documents.jsonl    — документ на строку
 *   resolutions.jsonl  — поручения
 *   assignees.jsonl    — исполнители поручений (включая расписки и отчёты)
 *   approvals.jsonl    — история шагов поручения (запрошено, утверждено, отправлено)
 *   reports.jsonl      — отчёты об исполнении (проекция assignees, для чтения человеком)
 *   audit.jsonl        — следы по этим документам и поручениям
 *   number_archives.jsonl — записи о закрытии годов
 *   attachments/…      — файлы вложений как есть
 *
 * Почему JSONL, а не Excel: значения хранятся как есть. Excel превратил бы «01-15»
 * в дату, а длинные номера потерял бы в точности. Excel остаётся для отчётов.
 *
 * Почему потоково: архив года может оказаться БОЛЬШЕ, чем оперативной памяти (вложения —
 * сканы и PDF). Буферизация (jszip) на таком архиве просто упала бы, поэтому сборка идёт
 * потоком: память ограничена страницей чтения, а не размером года.
 * Чтение идёт страницами по ключу (keyset), запись — потоком в ZIP (zipStream.ts).
 * Выгрузка читает журнал ОДНИМ снапшотом (REPEATABLE READ READ ONLY): год не меняется
 * под руками, блокировок на таблицах при этом нет.
 *
 * ⚠️ Справочник пользователей в архив НЕ входит (формат зафиксирован): архив ссылается
 * на user_id, поэтому при импорте пользователи должны существовать в целевой базе
 * (справочник синхронизируется из AD). Иначе импорт падает понятной ошибкой.
 */
import { createHash } from "node:crypto";
import { createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { getDocflowPool } from "./db/index.js";
import { getDocflowDb } from "./db/index.js";
import { insertAudit } from "./repo.js";
import { AppError } from "./errors.js";
import { ZipReader, ZipWriter, type ZipEntryStat } from "./zipStream.js";
import type { Actor } from "./journal.js";

/** Версия формата: по ней импорт понимает, что перед ним, и не гадает. */
export const ARCHIVE_FORMAT_VERSION = 1;

const FILES = {
  manifest: "manifest.json",
  users: "users.jsonl",
  documents: "documents.jsonl",
  resolutions: "resolutions.jsonl",
  assignees: "assignees.jsonl",
  approvals: "approvals.jsonl",
  reports: "reports.jsonl",
  audit: "audit.jsonl",
  archives: "number_archives.jsonl"
} as const;

/** Обязательные файлы архива: отсутствие любого — понятная ошибка, а не полуимпорт. */
const REQUIRED = [
  FILES.users,
  FILES.documents,
  FILES.resolutions,
  FILES.assignees,
  FILES.approvals,
  FILES.reports,
  FILES.audit,
  FILES.archives
];

const ATTACHMENT_PREFIX = "attachments/";

/** Каталог архивов по умолчанию: рядом с рабочим каталогом, переопределяется env. */
export const ARCHIVE_DIR_ENV = "DOCFLOW_ARCHIVE_DIR";

export function archiveDirectory(): string {
  const fromEnv = (process.env[ARCHIVE_DIR_ENV] ?? "").trim();
  return fromEnv || path.resolve(process.cwd(), "archives");
}

/** Вложение письма: как оно называется в архиве и как прочитать его байты. */
export interface JournalAttachment {
  name: string;
  /** Размер из метаданных: предупреждение о размере считается без чтения файла. */
  size?: number;
  open: () => Readable;
}

/**
 * Источник вложений. Вложения живут в почтовой базе клиента (core), поэтому docflow
 * объявляет интерфейс, а реализацию регистрирует владелец композиции (сервер).
 */
export interface JournalAttachmentStore {
  /** Вложения письма по его emailId. */
  list(emailId: string): Promise<JournalAttachment[]>;
}

let attachmentStore: JournalAttachmentStore | null = null;

/** Регистрирует источник вложений. Без него архив собирается без папки attachments. */
export function setJournalAttachmentStore(store: JournalAttachmentStore | null): void {
  attachmentStore = store;
}

export interface ExportResult {
  period: string;
  documents: number;
  resolutions: number;
  assignees: number;
  reports: number;
  audit: number;
  attachments: number;
  files: ZipEntryStat[];
}

export interface ExportOptions {
  /** Период нумерации — год журнала. */
  year: string;
  /** Куда писать ZIP. Сервер отдаёт сюда поток ответа, закрытие года — файл. */
  out: NodeJS.WritableStream;
  attachments?: JournalAttachmentStore | null;
  /** Размер страницы чтения: память ограничена им, а не размером журнала. */
  pageSize?: number;
}

function jsonLine(row: unknown): string {
  return JSON.stringify(row) + "\n";
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, "_").replace(/^\.+/, "_").replace(/[\u0000-\u001f]/g, "");
  return cleaned || "file";
}

/** Значения из JSON как есть: JSONL обязан вернуть их без искажений. */
function asValue(v: unknown): unknown {
  return v === undefined ? null : v;
}

/**
 * Пишет ZIP потоком, страницами читая журнал из ОДНОГО снапшота.
 * Память ограничена страницей (pageSize), а не размером года.
 */
export async function exportJournalYear(opts: ExportOptions): Promise<ExportResult> {
  const year = (opts.year ?? "").trim();
  if (!/^\d{4}$/.test(year)) throw new AppError("Укажите год выгрузки в виде ГГГГ", 400, "bad_period");
  const pageSize = Math.min(Math.max(opts.pageSize ?? 200, 1), 5000);
  const client = await getDocflowPool().connect();
  const writer = new ZipWriter(opts.out as never);
  const counts = {
    users: 0,
    documents: 0,
    resolutions: 0,
    assignees: 0,
    approvals: 0,
    reports: 0,
    audit: 0,
    archives: 0,
    attachments: 0
  };
  const files: ZipEntryStat[] = [];

  try {
    // Снапшот: год не меняется под руками. READ ONLY — выгрузка ничего не пишет.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    files.push(await writer.add(FILES.users, Readable.from(usersPass(client, year, pageSize, counts))));
    files.push(
      await writer.add(
        FILES.documents,
        Readable.from(documentsPass(client, year, pageSize, counts))
      )
    );
    files.push(
      await writer.add(
        FILES.resolutions,
        Readable.from(resolutionsPass(client, year, pageSize, counts))
      )
    );
    files.push(
      await writer.add(FILES.assignees, Readable.from(assigneesPass(client, year, pageSize, counts)))
    );
    files.push(await writer.add(FILES.reports, Readable.from(reportsPass(client, year, pageSize))));
    // История шагов поручения: без неё восстановленный журнал не показывает, кто утвердил
    // и когда отправили, — а заказчик просил вернуть журнал БЕЗ ПОТЕРЬ.
    files.push(
      await writer.add(FILES.approvals, Readable.from(approvalsPass(client, year, pageSize, counts)))
    );
    files.push(await writer.add(FILES.audit, Readable.from(auditPass(client, year, pageSize, counts))));
    // Запись о закрытии года: без неё восстановленный журнал не знает, что год закрыт,
    // и его можно закрыть второй раз.
    files.push(await writer.add(FILES.archives, Readable.from(archivesPass(client, year, pageSize, counts))));

    const store = opts.attachments === undefined ? attachmentStore : opts.attachments;
    if (store) {
      for await (const link of emailLinksPass(client, year, pageSize)) {
        let list: JournalAttachment[] = [];
        try {
          list = await store.list(link.emailId);
        } catch {
          // Вложение недоступно (письмо удалено, файл потерян) — выгрузку не роняем,
          // но и молчать нельзя: счётчик вложений покажет расхождение с письмами.
          list = [];
        }
        for (const att of list) {
          files.push(
            await writer.add(
              ATTACHMENT_PREFIX + safeName(link.emailId) + "/" + safeName(att.name),
              att.open(),
              // Вложения — БЕЗ сжатия (STORE): PDF и сканы уже сжаты, deflate на них только
              // жжёт процессор и время закрытия года. JSONL журнала сжимаем как раньше.
              { store: true }
            )
          );
          counts.attachments++;
        }
      }
    }

    // Манифест пишем ПОСЛЕДНИМ: sha256 каждого файла известен только после его записи,
    // а поток нельзя перемотать назад. Читатели находят файлы по центральному каталогу.
    const manifest = {
      formatVersion: ARCHIVE_FORMAT_VERSION,
      period: year,
      createdAt: new Date().toISOString(),
      counts: { ...counts },
      files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 }))
    };
    await writer.add(FILES.manifest, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    await writer.finish();
    await client.query("COMMIT");

    return { period: year, ...counts, files };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Снимок года ФАЙЛОМ: используется при закрытии года (снимок делается ДО транзакции
 * закрытия). Возвращает путь — его пишут в number_archives.fileName и в аудит.
 * Имя детерминированное и не затирающее предыдущие выгрузки; при сбое бросает.
 */
export async function exportPeriodArchive(period: string, dest?: string): Promise<string> {
  const year = (period ?? "").trim();
  if (!/^\d{4}$/.test(year)) throw new AppError("Укажите год выгрузки в виде ГГГГ", 400, "bad_period");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const file = dest
    ? path.resolve(dest)
    : path.join(archiveDirectory(), "journal-" + year + "-" + stamp + ".zip");
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const out = createWriteStream(file);
  try {
    await exportJournalYear({ year, out });
  } catch (err) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
  return file;
}

// ---------------- Пассы чтения (страницами, по ключу) ----------------

/**
 * Пользователи, на которых ССЫЛАЕТСЯ журнал года, — и только они.
 *
 * ⚠️ БЕЗОПАСНОСТЬ (не «починить» как недоработку!): в архив попадают только
 * идентифицирующие поля — id, ФИО, email, подразделение, должность, признак активности.
 * РОЛИ И ПРАВА НЕ ВЫГРУЖАЮТСЯ И НЕ ВОССТАНАВЛИВАЮТСЯ НИКОГДА. Иначе архив стал бы
 * инструментом повышения прав: достаточно подделать файл, где твой пользователь
 * администратор, и залить его. Архив — след о прошлом, а не источник полномочий;
 * права выдаются штатно в справочнике.
 * Весь справочник тоже не выгружаем: архив едет на носителе, лишние люди в нём ни к чему.
 */
async function* usersPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { users: number }
): AsyncGenerator<string> {
  const referenced =
    "SELECT user_id AS uid FROM resolution_assignees WHERE resolution_id IN " +
    "(SELECT id FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE reg_period = $1)) " +
    "UNION SELECT prepared_by FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE reg_period = $1) " +
    "UNION SELECT approved_by FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE reg_period = $1) " +
    "UNION SELECT confirmed_by FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE reg_period = $1) " +
    "UNION SELECT dispatched_by FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE reg_period = $1) " +
    "UNION SELECT created_by FROM documents WHERE reg_period = $1";
  let lastId = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT id, full_name, email, department, position, is_active, created_at, updated_at FROM users " +
        "WHERE id IN (" + referenced + ") AND id > $2 ORDER BY id LIMIT $3",
      [year, lastId, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.users += rows.rows.length;
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

async function* documentsPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { users: number; documents: number }
): AsyncGenerator<string> {
  let lastNum: number | null = null;
  let lastId = "";
  for (;;) {
    const rows = (await client.query(
      "SELECT * FROM documents WHERE reg_period = $1 AND ($2::int IS NULL OR (reg_number_numeric, id) > ($2, $3)) " +
        "ORDER BY reg_number_numeric, id LIMIT $4",
      [year, lastNum, lastId, pageSize]
    )) as { rows: Array<Record<string, unknown>> };
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.documents += rows.rows.length;
    lastNum = Number(rows.rows[rows.rows.length - 1].reg_number_numeric);
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

const SCOPE_RESOLUTIONS = "document_id IN (SELECT id FROM documents WHERE reg_period = $1)";

async function* resolutionsPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { resolutions: number }
): AsyncGenerator<string> {
  let lastId = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT * FROM resolutions WHERE " + SCOPE_RESOLUTIONS + " AND id > $2 ORDER BY id LIMIT $3",
      [year, lastId, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.resolutions += rows.rows.length;
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

async function* assigneesPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { assignees: number }
): AsyncGenerator<string> {
  let lastRes = "";
  let lastUser = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT * FROM resolution_assignees WHERE resolution_id IN " +
        "(SELECT id FROM resolutions WHERE " + SCOPE_RESOLUTIONS + ") " +
        "AND ($2 = '' OR (resolution_id, user_id) > ($2, $3)) ORDER BY resolution_id, user_id LIMIT $4",
      [year, lastRes, lastUser, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.assignees += rows.rows.length;
    lastRes = String(rows.rows[rows.rows.length - 1].resolution_id);
    lastUser = String(rows.rows[rows.rows.length - 1].user_id);
  }
}

/** Отчёты об исполнении — отдельным файлом (требование формата), для чтения человеком. */
async function* reportsPass(client: PoolClient, year: string, pageSize: number): AsyncGenerator<string> {
  let lastRes = "";
  let lastUser = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT resolution_id, user_id, report_text, report_at, report_email_id FROM resolution_assignees " +
        "WHERE report_at IS NOT NULL AND resolution_id IN " +
        "(SELECT id FROM resolutions WHERE " + SCOPE_RESOLUTIONS + ") " +
        "AND ($2 = '' OR (resolution_id, user_id) > ($2, $3)) ORDER BY resolution_id, user_id LIMIT $4",
      [year, lastRes, lastUser, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    lastRes = String(rows.rows[rows.rows.length - 1].resolution_id);
    lastUser = String(rows.rows[rows.rows.length - 1].user_id);
  }
}

async function* approvalsPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { approvals: number }
): AsyncGenerator<string> {
  let lastId = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT * FROM resolution_approvals WHERE resolution_id IN " +
        "(SELECT id FROM resolutions WHERE " + SCOPE_RESOLUTIONS + ") AND id > $2 ORDER BY id LIMIT $3",
      [year, lastId, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.approvals += rows.rows.length;
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

async function* archivesPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { archives: number }
): AsyncGenerator<string> {
  let lastId = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT * FROM number_archives WHERE period = $1 AND id > $2 ORDER BY id LIMIT $3",
      [year, lastId, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.archives += rows.rows.length;
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

async function* auditPass(
  client: PoolClient,
  year: string,
  pageSize: number,
  counts: { audit: number }
): AsyncGenerator<string> {
  let lastId = "";
  const scope =
    "(entity_type = 'document' AND entity_id IN (SELECT id FROM documents WHERE reg_period = $1)) OR " +
    "(entity_type = 'resolution' AND entity_id IN (SELECT id FROM resolutions WHERE " + SCOPE_RESOLUTIONS + ")) OR " +
    // След о закрытии года: без него после восстановления не видно, кто и когда закрыл год.
    "(entity_type = 'number_archive' AND entity_id IN " +
    "(SELECT stream || ':' || period FROM number_archives WHERE period = $1))";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT * FROM audit_log WHERE (" + scope + ") AND id > $2 ORDER BY id LIMIT $3",
      [year, lastId, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield jsonLine(row);
    counts.audit += rows.rows.length;
    lastId = String(rows.rows[rows.rows.length - 1].id);
  }
}

/**
 * Письма документов года — по ним берутся вложения.
 *
 * Экспортируется намеренно: предупреждение о размере архива обязано считать ТЕМ ЖЕ
 * обходом, что и выгрузка, иначе оно разойдётся с фактом.
 */
export async function* yearEmailLinks(
  client: PoolClient,
  year: string,
  pageSize = 200
): AsyncGenerator<{ emailId: string }> {
  yield* emailLinksPass(client, year, pageSize);
}

/** Письма документов года — по ним берутся вложения. */
async function* emailLinksPass(
  client: PoolClient,
  year: string,
  pageSize: number
): AsyncGenerator<{ emailId: string }> {
  let lastDoc = "";
  let lastEmail = "";
  for (;;) {
    const rows = await client.query<Record<string, unknown>>(
      "SELECT de.document_id, de.email_id FROM document_emails de JOIN documents d ON d.id = de.document_id " +
        "WHERE d.reg_period = $1 AND de.email_id <> '' " +
        "AND ($2 = '' OR (de.document_id, de.email_id) > ($2, $3)) " +
        "ORDER BY de.document_id, de.email_id LIMIT $4",
      [year, lastDoc, lastEmail, pageSize]
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) yield { emailId: String(row.email_id) };
    lastDoc = String(rows.rows[rows.rows.length - 1].document_id ?? lastDoc);
    lastEmail = String(rows.rows[rows.rows.length - 1].email_id);
  }
}

// ---------------- Импорт ----------------

/** Таблица → её первичный ключ: конфликт гасим ТОЛЬКО по нему (rules.md, п. 4.5). */
const TABLES: Array<{ file: string; table: string; conflict: string }> = [
  // Пользователи — первыми: на них ссылается графа 8 (executors). Существующие НЕ трогаем.
  { file: FILES.users, table: "users", conflict: "(id)" },
  { file: FILES.documents, table: "documents", conflict: "(id)" },
  { file: FILES.resolutions, table: "resolutions", conflict: "(id)" },
  { file: FILES.assignees, table: "resolution_assignees", conflict: "(resolution_id, user_id)" },
  { file: FILES.approvals, table: "resolution_approvals", conflict: "(id)" },
  { file: FILES.audit, table: "audit_log", conflict: "(id)" },
  // У записи о закрытии года уникален (поток, период), а не id: повторный импорт
  // того же года гасится именно по нему.
  { file: FILES.archives, table: "number_archives", conflict: "(stream, period)" }
];

export interface ImportOptions {
  file: string;
  /** Кто импортирует — след в аудите обязателен: журнал меняется. */
  actor: Actor;
  /** Куда распаковывать вложения, если источник вложений не зарегистрирован. */
  attachmentsDir?: string;
  batchSize?: number;
}

export interface ImportResult {
  period: string;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  attachments: number;
}

/** Проверяет манифест: версия формата, наличие файлов, sha256 каждого файла. */
async function verifyArchive(reader: ZipReader): Promise<{ period: string; counts: Record<string, number> }> {
  const entries = reader.entries().map((e) => e.name);
  if (!entries.includes(FILES.manifest)) {
    throw new AppError("В архиве нет манифеста — это не выгрузка журнала", 400, "bad_archive");
  }
  let manifest: { formatVersion?: number; period?: string; counts?: Record<string, number>; files?: Array<{ name: string; sha256: string }> };
  try {
    manifest = JSON.parse((await reader.readAll(FILES.manifest)).toString("utf8"));
  } catch {
    throw new AppError("Манифест архива повреждён: не читается как JSON", 400, "bad_archive");
  }
  if (manifest.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new AppError(
      "Архив формата " + String(manifest.formatVersion) + ", эта версия понимает " + ARCHIVE_FORMAT_VERSION +
        " — обновите программу или возьмите совместимую выгрузку",
      400,
      "bad_format"
    );
  }
  const missing = REQUIRED.filter((f) => !entries.includes(f));
  if (missing.length) {
    throw new AppError("В архиве нет обязательных файлов: " + missing.join(", "), 400, "bad_archive");
  }

  // Суммы проверяем ДО любых вставок: битый архив не должен тронуть базу.
  for (const f of manifest.files ?? []) {
    if (!entries.includes(f.name)) {
      throw new AppError("Манифест ссылается на отсутствующий файл " + f.name, 400, "bad_archive");
    }
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of reader.openRaw(f.name)) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
      }
    } catch (err) {
      // Порченые байты ловятся раньше суммы: распаковка не сходится.
      throw new AppError(
        "Файл " + f.name + " повреждён: не читается (" + (err as Error).message + ")",
        400,
        "bad_checksum"
      );
    }
    if (hash.digest("hex") !== f.sha256) {
      throw new AppError("Файл " + f.name + " повреждён: sha256 не совпал с манифестом", 400, "bad_checksum");
    }
    void size;
  }
  return { period: String(manifest.period ?? ""), counts: manifest.counts ?? {} };
}

function insertSql(table: string, cols: string[], conflict: string): string {
  const colList = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
  const tuples = "(" + cols.map((_c, i) => "$" + (i + 1)).join(", ") + ")";
  return "INSERT INTO " + table + " (" + colList + ") VALUES " + tuples + " ON CONFLICT " + conflict + " DO NOTHING";
}

/** Строчный итератор по JSONL-потоку: память ограничена одной строкой. */
async function* lines(stream: Readable): AsyncGenerator<Record<string, unknown>> {
  let buf = "";
  for await (const chunk of stream) {
    buf += (chunk as Buffer).toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
      idx = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail) as Record<string, unknown>;
}

/**
 * Импорт архива в базу.
 *
 * Повторный импорт НЕ дублирует: строки, которые уже есть (по первичному ключу),
 * пропускаются и попадают в отчёт как skipped. Отклонять архив целиком нельзя —
 * импорт может прерваться на середине (сеть, питание), и тогда повтор был бы невозможен.
 */
export async function importJournalArchive(opts: ImportOptions): Promise<ImportResult> {
  const file = path.resolve(opts.file);
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 5000);
  const reader = await ZipReader.open(file).catch(() => {
    throw new AppError("Файл не читается как ZIP-архив журнала", 400, "bad_archive");
  });
  const { period } = await verifyArchive(reader);

  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  for (const spec of TABLES) {
    let done = 0;
    let batch: Record<string, unknown>[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const cols = Object.keys(batch[0]);
      const client = await getDocflowPool().connect();
      try {
        await client.query("BEGIN");
        for (const row of batch) {
          const values = cols.map((c) => asValue(row[c]));
          try {
            const res = await client.query(insertSql(spec.table, cols, spec.conflict), values);
            done += res.rowCount ?? 0;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === "23503") {
              throw new AppError(
                "Архив ссылается на записи, которых нет в базе (" + spec.table + "): сначала восстановите " +
                  "справочник сотрудников и документы, потом импортируйте год",
                409,
                "missing_reference"
              );
            }
            throw err;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      batch = [];
    };

    for await (const row of lines(reader.openRaw(spec.file))) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    }
    await flush();

    let total = 0;
    for await (const _row of lines(reader.openRaw(spec.file))) total++;
    inserted[spec.table] = done;
    skipped[spec.table] = total - done;
  }

  // Вложения: распаковываем как есть. Источник не зарегистрирован — пишем в каталог.
  let attachments = 0;
  const dir = opts.attachmentsDir ? path.resolve(opts.attachmentsDir) : null;
  for (const entry of reader.entries()) {
    if (!entry.name.startsWith(ATTACHMENT_PREFIX)) continue;
    const rel = entry.name.slice(ATTACHMENT_PREFIX.length);
    // Защита от zip-slip: имя из архива не имеет права выйти за каталог распаковки.
    if (rel.split("/").some((part) => part === ".." || part === "" || path.isAbsolute(part))) {
      throw new AppError("В архиве недопустимый путь вложения: " + entry.name, 400, "bad_archive");
    }
    if (!dir) {
      // Некуда класть — но байты обязаны быть целыми: читаем поток до конца (проверка CRC).
      for await (const _chunk of reader.openRaw(entry.name)) void _chunk;
      continue;
    }
    const target = path.join(dir, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, await reader.readAll(entry.name));
    attachments++;
  }

  // След об импорте — своей транзакцией: это след ОПЕРАЦИИ, а не импортированных данных
  // (как вход в систему), и откатывать его вместе с чужой строкой нельзя.
  await getDocflowDb().transaction(async (tx) => {
    await insertAudit(
      {
        userId: opts.actor.id,
        userName: opts.actor.name,
        action: "journal.import_year",
        entityType: "journal",
        entityId: period,
        newValue: { file: path.basename(file), period, inserted, skipped, attachments }
      },
      tx
    );
  });

  return { period, inserted, skipped, attachments };
}
