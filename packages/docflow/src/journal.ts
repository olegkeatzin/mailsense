/**
 * Журнал регистрации входящих документов (СЭД, этап 2).
 *
 * Здесь живёт всё, что связано с записью журнала: нумерация, регистрация,
 * поиск, дубли, справочники. Почтовые данные сюда не попадают — связь с письмами
 * идёт по строковому email_id, потому что почта лежит в базе клиента.
 */
import { companyDayIso } from "./companyDay.js";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { getDocflowDb, getDocflowPool } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { writeAudit } from "./audit.js";
import { insertAudit } from "./repo.js";
import { AppError, isUniqueViolation } from "./errors.js";
import {
  DEFAULT_NUMBERING_RULES,
  canOpenPeriod,
  canReopenPeriod,
  periodKey,
  renderNumber,
  reopenablePeriods,
  ruleForStream,
  type NumberingRule
} from "./numbering.js";
import type {
  CaseNomenclatureRecord,
  CorrespondentRecord,
  DocumentEmailRole,
  DocumentFilter,
  DocumentInput,
  DocumentListItem,
  DocumentPage,
  DocumentPatch,
  DocumentRecord,
  DocumentStatus,
  DuplicateMatch,
  NumberingRuleRecord,
  NumberingState
} from "./types.js";

const { documents, documentEmails, numberRules, numberArchives, caseNomenclature, correspondents, users, auditLog } = docflowSchema;

/** count(*) в PostgreSQL приходит как bigint (строкой) — приводим к int в запросе. */
const countExpr = sql.raw("count(*)::int");
const emailsCountExpr = sql.raw(
  "(select count(*)::int from document_emails de where de.document_id = documents.id)"
);

/** Кто выполняет действие: id и ФИО для аудита. */
export interface Actor {
  id: string | null;
  name: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Сегодняшняя дата в виде ГГГГ-ММ-ДД — день предприятия (T47).
 * Журнал и сроки обязаны считать день одинаково, поэтому живёт это в одном месте.
 */
export function todayIso(d: Date = new Date()): string {
  return companyDayIso(d);
}

function mapDocument(row: typeof documents.$inferSelect): DocumentRecord {
  return {
    id: row.id,
    regNumber: row.regNumber,
    regNumberNumeric: row.regNumberNumeric,
    regPeriod: row.regPeriod,
    regDate: row.regDate,
    docNumber: row.docNumber,
    docDate: row.docDate,
    sender: row.sender,
    summary: row.summary,
    sheetsCount: row.sheetsCount,
    caseNumber: row.caseNumber,
    documentName: row.documentName,
    status: row.status as DocumentStatus,
    emailId: row.emailId,
    docFilesPath: row.docFilesPath,
    correspondentId: row.correspondentId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt
  };
}

// ---------------- Нумерация ----------------

function toRule(r: NumberingRuleRecord): NumberingRule {
  return {
    stream: r.stream as NumberingRule["stream"],
    prefix: r.prefix,
    reset: r.reset,
    template: r.template ?? undefined
  };
}

/**
 * Строки запроса — либо через клиента транзакции, либо через пул.
 *
 * Внутри ручной транзакции (registerDocument) читать через пул нельзя: это второе
 * соединение, которое к тому же исчерпывает пул под нагрузкой (10 одновременных
 * регистраций встают намертво, ожидая соединение у самих себя).
 */
async function queryRows<T extends Record<string, unknown>>(
  client: PoolClient | undefined,
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  if (client) return (await client.query<T>(text, params)).rows;
  return (await getDocflowPool().query<T>(text, params)).rows;
}

/** Правила нумерации в виде домена: из базы плюс умолчания для отсутствующих потоков. */
function numberingRulesFrom(
  rows: Array<{ stream: string; prefix: string; reset: string; template: string | null }>
): NumberingRuleRecord[] {
  const out: NumberingRuleRecord[] = rows.map((r) => ({
    stream: r.stream,
    prefix: r.prefix,
    reset: (r.reset === "never" ? "never" : "year") as "year" | "never",
    template: r.template
  }));
  // Правила обязаны быть: без них регистрация невозможна.
  for (const def of DEFAULT_NUMBERING_RULES) {
    if (!out.some((r) => r.stream === def.stream)) {
      out.push({ stream: def.stream, prefix: def.prefix, reset: def.reset, template: def.template ?? null });
    }
  }
  return out;
}

export async function listNumberingRules(): Promise<NumberingRuleRecord[]> {
  const rows = await queryRows<{ stream: string; prefix: string; reset: string; template: string | null }>(
    undefined,
    "SELECT stream, prefix, reset, template FROM number_rules"
  );
  return numberingRulesFrom(rows);
}

export async function saveNumberingRule(rule: NumberingRuleRecord, actor: Actor): Promise<NumberingRuleRecord> {
  const db = getDocflowDb();
  const before = (await db.select().from(numberRules).where(eq(numberRules.stream, rule.stream)))[0] ?? null;

  // Видимую часть номера (префикс и шаблон) нельзя менять, когда период уже
  // начат: в журнале оказались бы «вх1» и «ВХ-2» рядом, и бумажный журнал
  // перестал бы сходиться с электронным.
  if (before && (before.prefix !== rule.prefix || (before.template ?? null) !== (rule.template ?? null))) {
    const state = await loadPeriodState(rule.stream);
    if (state.openPeriod) {
      const used = await db
        .select({ n: countExpr })
        .from(documents)
        .where(eq(documents.regPeriod, state.openPeriod));
      if (Number(used[0]?.n ?? 0) > 0) {
        throw new AppError(
          "В " + state.openPeriod + " году уже есть документы — префикс и шаблон менять нельзя. " +
            "Дождитесь выгрузки года в архив.",
          409,
          "numbering_locked"
        );
      }
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(numberRules)
      .values({ stream: rule.stream, prefix: rule.prefix, reset: rule.reset, template: rule.template })
      .onConflictDoUpdate({
        target: numberRules.stream,
        set: { prefix: rule.prefix, reset: rule.reset, template: rule.template }
      });
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "journal.numbering.save",
      entityType: "number_rule",
      entityId: rule.stream,
      oldValue: stringifyAudit(before),
      newValue: stringifyAudit(rule),
      createdAt: now()
    });
  });
  return rule;
}

/** Открытый период (год с документами) и годы, выгруженные в архив. */
async function loadPeriodState(
  stream: string,
  client?: PoolClient
): Promise<{ openPeriod: string | null; archivedPeriods: string[] }> {
  const open = await queryRows<{ period: string }>(
    client,
    "SELECT reg_period AS period FROM documents ORDER BY reg_period DESC LIMIT 1"
  );
  const arch = await queryRows<{ period: string }>(client, "SELECT period FROM number_archives WHERE stream = $1", [
    stream
  ]);
  return { openPeriod: open[0]?.period ?? null, archivedPeriods: arch.map((a) => a.period) };
}

/** Состояние нумерации для UI: правила, открытый год, закрытые годы, причина блокировки. */
export async function getNumberingState(period?: string): Promise<NumberingState> {
  const rules = await listNumberingRules();
  const incoming = ruleForStream(rules.map(toRule), "incoming");
  const state = await loadPeriodState("incoming");
  const target = period ?? periodKey(new Date(), incoming.reset);
  const gate = canOpenPeriod(target, state);
  return {
    rules,
    openPeriod: state.openPeriod,
    archivedPeriods: state.archivedPeriods,
    // Годы, закрытие которых ещё можно отменить: интерфейс показывает это ДО нажатия,
    // но решает всё равно транзакция переоткрытия (между показом и нажатием могли
    // зарегистрировать документ).
    reopenablePeriods: reopenablePeriods(state),
    blockedReason: gate.ok ? null : gate.reason ?? null
  };
}

/**
 * Атомарный инкремент счётчика. Делается ОДНИМ запросом: INSERT ... ON CONFLICT
 * DO UPDATE блокирует строку и увеличивает значение, поэтому две одновременные
 * регистрации не получат один и тот же номер.
 */
function stringifyAudit(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface AuditTrailEntry {
  userId: string | null;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Запись аудита ВНУТРИ транзакции изменения.
 *
 * Так «кто и что изменил» гарантировано: либо есть и документ, и запись
 * в журнале аудита, либо нет ни того, ни другого. Иначе при сбое записи
 * аудита изменение осталось бы без следов — а искать виноватого будет нечем.
 */
async function auditInTx(client: PoolClient, e: AuditTrailEntry): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (id, user_id, user_name, action, entity_type, entity_id, old_value, new_value, created_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      randomUUID(),
      e.userId,
      e.userName,
      e.action,
      e.entityType,
      e.entityId,
      stringifyAudit(e.oldValue),
      stringifyAudit(e.newValue),
      now()
    ]
  );
}

async function takeNextNumber(client: PoolClient, stream: string, period: string): Promise<number> {
  const res = await client.query<{ last_number: number }>(
    "INSERT INTO number_counters (stream, period, last_number) VALUES ($1, $2, 1) " +
      "ON CONFLICT (stream, period) DO UPDATE SET last_number = number_counters.last_number + 1 " +
      "RETURNING last_number",
    [stream, period]
  );
  return res.rows[0].last_number;
}

/**
 * Берёт строку счётчика периода ПЕРВОЙ — до чтения состояния периода.
 *
 * ⚠️ \`SELECT ... FOR UPDATE\` по НЕсуществующей строке не блокирует НИЧЕГО (rules §4.2),
 * поэтому сначала обеспечиваем существование строки, и только потом блокируем её.
 * Строка с last_number = 0 ни на что не влияет: подсказка номера показывает «следующий 1»,
 * а выдача номера начинает счёт с единицы.
 *
 * Один и тот же первый захват во всех путях — регистрация, закрытие года, отмена закрытия:
 * разный порядок блокировок даёт взаимную блокировку, а без общего якоря закрытие года
 * и регистрация разъезжаются (документ попадает в закрытый год, не попав в архив).
 */
async function lockCounterRow(client: PoolClient, stream: string, period: string): Promise<void> {
  await client.query(
    "INSERT INTO number_counters (stream, period, last_number) VALUES ($1, $2, 0) " +
      "ON CONFLICT (stream, period) DO NOTHING",
    [stream, period]
  );
  await client.query("SELECT 1 FROM number_counters WHERE stream = $1 AND period = $2 FOR UPDATE", [stream, period]);
}

// ---------------- Регистрация ----------------

export interface RegisterInput extends DocumentInput {
  /** Дата регистрации; по умолчанию — сегодня. */
  regDate?: string;
}

/**
 * Регистрирует входящий документ: выдаёт номер и создаёт запись журнала.
 *
 * Всё в одной транзакции: если запись не удалась, счётчик тоже откатится —
 * «сгоревших» номеров не остаётся.
 */

/**
 * Следующий входящий номер БЕЗ выдачи — подсказка в форме регистрации.
 *
 * ⚠️ Это именно подсказка. Настоящий номер выдаёт база внутри транзакции (`takeNextNumber`),
 * и только он попадает в журнал. Если двое регистрируют одновременно, подсказка одного
 * окажется неверной — поэтому она и показывается как «будет присвоен», а не как поле.
 */
export async function peekNextNumber(): Promise<{ regNumber: string; period: string }> {
  const rules = await listNumberingRules();
  const rule = ruleForStream(rules.map(toRule), "incoming");
  const period = periodKey(new Date(todayIso() + "T12:00:00"), rule.reset);
  const rows = await getDocflowPool().query<{ last_number: number }>(
    "SELECT last_number FROM number_counters WHERE stream = $1 AND period = $2",
    ["incoming", period]
  );
  // Счётчика ещё нет — значит, это первый документ периода.
  const last = Number(rows.rows[0]?.last_number ?? 0);
  return { regNumber: renderNumber(rule, period, last + 1), period };
}

export async function registerDocument(input: RegisterInput, actor: Actor): Promise<DocumentRecord> {
  const pool = getDocflowPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Правила и состояние периода читаем ЭТИМ ЖЕ клиентом: второе соединение
    // из пула означало бы чтение вне транзакции и нехватку соединений под нагрузкой.
    const ruleRows = await queryRows<{ stream: string; prefix: string; reset: string; template: string | null }>(
      client,
      "SELECT stream, prefix, reset, template FROM number_rules"
    );
    const rules = numberingRulesFrom(ruleRows);
    const rule = ruleForStream(rules.map(toRule), "incoming");
    const regDate =
      input.regDate && /^\d{4}-\d{2}-\d{2}$/.test(input.regDate) ? input.regDate : todayIso();
    const period = periodKey(new Date(regDate + "T12:00:00"), rule.reset);

    // Строку счётчика берём ДО чтения состояния: тот же первый захват, что у закрытия
    // и отмены закрытия года. Иначе закрытие года не увидит эту регистрацию.
    await lockCounterRow(client, "incoming", period);

    const state = await loadPeriodState("incoming", client);
    const gate = canOpenPeriod(period, state);
    if (!gate.ok) throw new AppError(gate.reason ?? "Период закрыт", 409, "period_closed");

    // Повторная регистрация того же письма — понятная ошибка,
    // а не нарушение уникального индекса.
    if (input.emailId) {
      const dup = await client.query<{ id: string; reg_number: string }>(
        "SELECT d.id, d.reg_number FROM documents d JOIN document_emails de ON de.document_id = d.id " +
          "WHERE de.email_id = $1 AND de.role = $2 LIMIT 1",
        [input.emailId, "source"]
      );
      if (dup.rows.length) {
        throw new AppError("Письмо уже зарегистрировано: " + dup.rows[0].reg_number, 409, "duplicate_email");
      }
    }

    const num = await takeNextNumber(client, "incoming", period);
    const regNumber = renderNumber(rule, period, num);
    const id = randomUUID();
    const ts = now();

    await client.query(
      "INSERT INTO documents (id, reg_number, reg_number_numeric, reg_period, reg_date, doc_number, doc_date, " +
        "sender, summary, sheets_count, case_number, document_name, status, email_id, correspondent_id, " +
        "created_by, created_at, updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)",
      [
        id,
        regNumber,
        num,
        period,
        regDate,
        input.docNumber ?? "",
        input.docDate ?? null,
        input.sender ?? "",
        input.summary ?? "",
        input.sheetsCount ?? null,
        input.caseNumber ?? null,
        input.documentName ?? "",
        "new",
        input.emailId ?? null,
        input.correspondentId ?? null,
        actor.id,
        ts
      ]
    );

    if (input.emailId) {
      await client.query(
        "INSERT INTO document_emails (document_id, email_id, role, linked_at, linked_by) VALUES ($1,$2,$3,$4,$5)",
        [id, input.emailId, "source", ts, actor.id]
      );
    }

    // Аудит — в той же транзакции: изменение без следа невозможно.
    await auditInTx(client, {
      userId: actor.id,
      userName: actor.name,
      action: "journal.register",
      entityType: "document",
      entityId: id,
      newValue: {
        regNumber,
        regDate,
        emailId: input.emailId ?? null,
        sender: input.sender ?? "",
        docNumber: input.docNumber ?? "",
        summary: input.summary ?? ""
      }
    });

    await client.query("COMMIT");
    return (await getDocument(id))!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Неудачную попытку тоже фиксируем: «кто пытался и почему не вышло» —
    // это ровно тот случай, когда ищут виноватого. Пишем уже вне транзакции
    // (изменения нет — откатывать нечего), поэтому здесь writeAudit, а не auditInTx.
    if (err instanceof AppError && (err.code === "duplicate_email" || err.code === "period_closed")) {
      await writeAudit({
        userId: actor.id,
        userName: actor.name,
        action: "journal.register_denied",
        entityType: "document",
        entityId: input.emailId ?? "",
        newValue: { reason: err.code, message: err.message }
      });
    }
    throw err;
  } finally {
    client.release();
  }
}
// ---------------- Чтение ----------------

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const rows = await getDocflowDb().select().from(documents).where(eq(documents.id, id)).limit(1);
  return rows[0] ? mapDocument(rows[0]) : null;
}

/** Документ, зарегистрированный по этому письму (если есть). */
export async function getDocumentByEmail(emailId: string): Promise<DocumentRecord | null> {
  const db = getDocflowDb();
  const links = await db.select().from(documentEmails).where(eq(documentEmails.emailId, emailId));
  if (!links.length) return null;
  // Основное письмо важнее привязок «резолюция/отчёт».
  const source = links.find((l) => l.role === "source") ?? links[0];
  return getDocument(source.documentId);
}

function buildWhere(f: DocumentFilter) {
  const conds = [];
  const q = (f.search ?? "").trim();
  if (q) {
    const like = "%" + q + "%";
    // PostgreSQL сворачивает регистр кириллицы корректно (проверено на стенде),
    // поэтому ILIKE здесь безопасен — в отличие от SQLite.
    conds.push(
      or(
        ilike(documents.regNumber, like),
        ilike(documents.docNumber, like),
        ilike(documents.sender, like),
        ilike(documents.summary, like),
        ilike(documents.documentName, like),
        ilike(documents.caseNumber, like)
      )
    );
  }
  if (f.status) conds.push(eq(documents.status, f.status));
  if (f.period) conds.push(eq(documents.regPeriod, f.period));
  if (f.dateFrom) conds.push(gte(documents.regDate, f.dateFrom));
  if (f.dateTo) conds.push(lte(documents.regDate, f.dateTo));
  if (f.caseNumber) conds.push(eq(documents.caseNumber, f.caseNumber));
  if (f.correspondentId) conds.push(eq(documents.correspondentId, f.correspondentId));
  return conds.length ? and(...conds) : undefined;
}

const SORT_MAP = {
  regNumber: documents.regNumberNumeric,
  regDate: documents.regDate,
  docDate: documents.docDate,
  sender: documents.sender,
  summary: documents.summary,
  status: documents.status,
  createdAt: documents.createdAt
};

export async function listDocuments(f: DocumentFilter = {}): Promise<DocumentPage> {
  const db = getDocflowDb();
  const where = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const col = SORT_MAP[f.sort ?? "regNumber"] ?? documents.regNumberNumeric;
  const dir = f.order === "asc" ? asc : desc;

  const rows = await db
    .select({ doc: documents, createdByName: users.fullName, emailsCount: emailsCountExpr })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.createdBy))
    .where(where)
    .orderBy(dir(col))
    .limit(limit)
    .offset(offset);

  const totalRows = await db.select({ n: countExpr }).from(documents).where(where);
  const items: DocumentListItem[] = rows.map((r) => ({
    ...mapDocument(r.doc),
    createdByName: r.createdByName ?? "",
    emailsCount: Number(r.emailsCount ?? 0)
  }));
  return { items, total: Number(totalRows[0]?.n ?? 0) };
}

/** Письма, уже ставшие источником документа: нужны разделу «Входящие на регистрацию». */
export async function listRegisteredEmailIds(): Promise<string[]> {
  const rows = await getDocflowDb()
    .select({ emailId: documentEmails.emailId })
    .from(documentEmails)
    .where(eq(documentEmails.role, "source"));
  return rows.map((r) => r.emailId);
}

/** Все записи журнала по фильтру — для выгрузки в Excel (без постраничности). */
export async function listDocumentsForExport(f: DocumentFilter = {}): Promise<DocumentListItem[]> {
  const page = await listDocuments({ ...f, limit: 500, offset: 0 });
  const out = [...page.items];
  while (out.length < page.total) {
    const next = await listDocuments({ ...f, limit: 500, offset: out.length });
    if (!next.items.length) break;
    out.push(...next.items);
  }
  return out;
}

export async function listDocumentEmails(
  documentId: string
): Promise<Array<{ emailId: string; role: DocumentEmailRole; linkedAt: string }>> {
  const rows = await getDocflowDb().select().from(documentEmails).where(eq(documentEmails.documentId, documentId));
  return rows.map((r) => ({ emailId: r.emailId, role: r.role as DocumentEmailRole, linkedAt: r.linkedAt }));
}

// ---------------- Правка ----------------

export async function updateDocument(id: string, patch: DocumentPatch, actor: Actor): Promise<DocumentRecord | null> {
  const before = await getDocument(id);
  if (!before) return null;

  const set: Record<string, unknown> = { updatedAt: now() };
  if (patch.docNumber !== undefined) set.docNumber = patch.docNumber;
  if (patch.docDate !== undefined) set.docDate = patch.docDate;
  if (patch.sender !== undefined) set.sender = patch.sender;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.sheetsCount !== undefined) set.sheetsCount = patch.sheetsCount;
  if (patch.caseNumber !== undefined) set.caseNumber = patch.caseNumber;
  if (patch.documentName !== undefined) set.documentName = patch.documentName;
  if (patch.correspondentId !== undefined) set.correspondentId = patch.correspondentId;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.docFilesPath !== undefined) set.docFilesPath = patch.docFilesPath;
  if (patch.regDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.regDate)) set.regDate = patch.regDate;

  // Правка и её след — в одной транзакции: иначе «кто изменил» могло потеряться,
  // а именно это и нужно, когда ищут, кто внёс ошибку.
  return getDocflowDb().transaction(async (tx) => {
    await tx.update(documents).set(set).where(eq(documents.id, id));
    const rows = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
    const after = rows[0] ? mapDocument(rows[0]) : null;
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "journal.edit",
      entityType: "document",
      entityId: id,
      oldValue: stringifyAudit(before),
      newValue: stringifyAudit(after),
      createdAt: now()
    });
    return after;
  });
}

/** Запоминает папку вложений дела. Служебная операция: аудит не нужен. */
export async function setDocumentFilesPath(id: string, docFilesPath: string): Promise<void> {
  await getDocflowDb()
    .update(documents)
    .set({ docFilesPath, updatedAt: now() })
    .where(eq(documents.id, id));
}

/** Привязывает письмо к документу (резолюция, отчёт об исполнении). */
export async function linkDocumentEmail(
  documentId: string,
  emailId: string,
  role: DocumentEmailRole,
  actor: Actor
): Promise<void> {
  const doc = await getDocument(documentId);
  if (!doc) throw new AppError("Документ не найден", 404, "not_found");
  // Привязка письма и след — одна транзакция: письмо, привязанное без следа,
  // невозможно отличить от привязанного вручную мимо системы.
  await getDocflowDb().transaction(async (tx) => {
    // ⚠️ Гасим конфликт ТОЛЬКО по первичному ключу (документ + письмо): повторная
    // привязка того же письма к тому же документу — no-op, и следа она не пишет.
    // `onConflictDoNothing()` без цели гасил бы и нарушение частичного индекса
    // document_emails_source_idx (одно письмо — источник ровно одного документа):
    // связь молча не создавалась бы, транзакция коммитилась, а в аудит уходил бы
    // ложный след «связь создана». Ложный след хуже отказа: по аудиту ищут виноватого.
    let inserted: Array<{ emailId: string }>;
    try {
      inserted = await tx
        .insert(documentEmails)
        .values({ documentId, emailId, role, linkedAt: now(), linkedBy: actor.id })
        .onConflictDoNothing({ target: [documentEmails.documentId, documentEmails.emailId] })
        .returning({ emailId: documentEmails.emailId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(
          "Письмо уже привязано к другому документу как источник",
          409,
          "email_linked"
        );
      }
      throw err;
    }
    // След — только когда связь действительно появилась (сбой записи следа
    // откатывает и связь: AGENTS.md, п. 4).
    if (!inserted.length) return;
    await insertAudit(
      {
        userId: actor.id,
        userName: actor.name,
        action: "journal.link_email",
        entityType: "document",
        entityId: documentId,
        newValue: { emailId, role }
      },
      tx
    );
  });
}

// ---------------- Дубли ----------------

/**
 * Ищет возможные дубли перед регистрацией: то же письмо, тот же номер документа,
 * то же краткое содержание. Возвращает найденное — решение принимает человек.
 */
export async function findDuplicates(input: {
  emailId?: string | null;
  docNumber?: string;
  summary?: string;
}): Promise<DuplicateMatch[]> {
  const db = getDocflowDb();
  const out: DuplicateMatch[] = [];

  const push = (rows: Array<{ doc: typeof documents.$inferSelect }>, reason: DuplicateMatch["reason"]): void => {
    for (const r of rows) out.push({ document: { ...mapDocument(r.doc), createdByName: "", emailsCount: 0 }, reason });
  };

  if (input.emailId) {
    const rows = await db
      .select({ doc: documents })
      .from(documentEmails)
      .innerJoin(documents, eq(documents.id, documentEmails.documentId))
      .where(and(eq(documentEmails.emailId, input.emailId), eq(documentEmails.role, "source")));
    push(rows, "email");
  }

  const docNumber = (input.docNumber ?? "").trim();
  if (docNumber) {
    const rows = await db.select({ doc: documents }).from(documents).where(eq(documents.docNumber, docNumber)).limit(5);
    push(rows, "docNumber");
  }

  const summary = (input.summary ?? "").trim();
  if (summary.length >= 10) {
    // Короткие темы совпадают случайно — ищем только по содержательным.
    const rows = await db.select({ doc: documents }).from(documents).where(ilike(documents.summary, summary)).limit(5);
    push(rows, "summary");
  }

  // Один документ не должен попасть в список дважды (например, по номеру и теме).
  const seen = new Set<string>();
  return out.filter((m) => {
    if (seen.has(m.document.id)) return false;
    seen.add(m.document.id);
    return true;
  });
}

// ---------------- Архив периода ----------------

export interface ArchivePeriodInput {
  stream?: string;
  period: string;
  fileName?: string;
  documentCount?: number;
}

/**
 * Запись архива и след — в ОДНОЙ транзакции: «год закрыт» без записи в аудите означало бы,
 * что неизвестно, кто открыл следующий.
 */
async function insertArchiveRecord(client: PoolClient, input: ArchivePeriodInput, actor: Actor): Promise<void> {
  const stream = input.stream ?? "incoming";
  await client.query(
    "INSERT INTO number_archives (id, stream, period, file_name, document_count, created_at, created_by) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (stream, period) DO NOTHING",
    [
      randomUUID(),
      stream,
      input.period,
      input.fileName ?? "",
      input.documentCount ?? 0,
      now(),
      actor.id
    ]
  );
  await auditInTx(client, {
    userId: actor.id,
    userName: actor.name,
    action: "journal.archive_period",
    entityType: "number_archive",
    entityId: stream + ":" + input.period,
    newValue: { period: input.period, fileName: input.fileName ?? "", documentCount: input.documentCount ?? 0 }
  });
}

/** Выгрузка журнала в архив: закрывает год, после чего открывается следующий. */
export async function archivePeriod(input: ArchivePeriodInput, actor: Actor): Promise<void> {
  const client = await getDocflowPool().connect();
  try {
    await client.query("BEGIN");
    await insertArchiveRecord(client, input, actor);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ClosePeriodInput extends ArchivePeriodInput {
  /**
   * Сколько документов было в снимке. Если в базе уже больше — значит во время выгрузки
   * зарегистрировали документ, архив неполный, и закрывать год по нему нельзя.
   */
  documentCount?: number;
}

export interface ClosePeriodResult {
  period: string;
  fileName: string;
  documentCount: number;
}

/**
 * Закрывает год — строгая версия archivePeriod для маршрута закрытия.
 *
 * Отличия от archivePeriod (та осталась для служебных вызовов и тестов):
 *  • строка счётчика года берётся ПЕРВОЙ, поэтому регистрация документа в этом же году
 *    не может проскользнуть между проверкой и записью архива;
 *  • год обязан быть открытым и ещё не выгруженным (повторное закрытие — отказ, а не тихий «успех»);
 *  • число документов сверяется со снимком: если оно изменилось, закрытие отклоняется —
 *    иначе в закрытом году остался бы документ, которого нет в архиве;
 *  • запись архива и след пишутся в той же транзакции.
 */
export async function closePeriod(input: ClosePeriodInput, actor: Actor): Promise<ClosePeriodResult> {
  const stream = input.stream ?? "incoming";
  const period = input.period;
  if (!/^\d{4}$/.test(period)) throw new AppError("Укажите год в виде ГГГГ", 400, "bad_period");

  const client = await getDocflowPool().connect();
  try {
    await client.query("BEGIN");
    await lockCounterRow(client, stream, period);

    const state = await loadPeriodState(stream, client);
    if (state.archivedPeriods.includes(period)) {
      throw new AppError("Год " + period + " уже выгружен в архив", 409, "already_archived");
    }
    if (!state.openPeriod) {
      throw new AppError("В журнале ещё нет документов — закрывать нечего", 400, "empty_journal");
    }
    if (state.openPeriod !== period) {
      throw new AppError(
        "Закрыть можно только открытый год (" +
          state.openPeriod +
          "): " +
          period +
          " закроется навсегда. Выгрузите журнал за " +
          state.openPeriod +
          ".",
        409,
        "not_open_period"
      );
    }

    const counted = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM documents WHERE reg_period = $1",
      [period]
    );
    const actual = Number(counted.rows[0]?.n ?? 0);
    if (typeof input.documentCount === "number" && input.documentCount !== actual) {
      throw new AppError(
        "Во время выгрузки в " +
          period +
          " году появились новые документы (" +
          actual +
          " вместо " +
          input.documentCount +
          "): архив неполный. Выгрузите год заново.",
        409,
        "period_changed"
      );
    }

    await insertArchiveRecord(client, { ...input, documentCount: actual }, actor);
    await client.query("COMMIT");
    return { period, fileName: input.fileName ?? "", documentCount: actual };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ReopenPeriodInput {
  stream?: string;
  period: string;
  /** Почему отменяем: отмена закрытия года — объяснимое действие, но не молчаливое. */
  reason: string;
}

/**
 * Отменяет закрытие года — ровно пока в новом году нет ни одного документа.
 *
 * Проверка и удаление записи архива — в ОДНОЙ транзакции, и первой берётся строка счётчика
 * НОВОГО года: её же берёт регистрация документа нового года. Без этого между проверкой
 * «в новом году пусто» и отменой кто-то успел бы зарегистрировать документ, и мы получили бы
 * ту же дыру с другой стороны.
 */
export async function reopenPeriod(input: ReopenPeriodInput, actor: Actor): Promise<{ period: string }> {
  const stream = input.stream ?? "incoming";
  const period = input.period;
  if (!/^\d{4}$/.test(period)) throw new AppError("Укажите год в виде ГГГГ", 400, "bad_period");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new AppError("Укажите причину отмены закрытия года", 400, "bad_reason");

  const client = await getDocflowPool().connect();
  try {
    await client.query("BEGIN");
    await lockCounterRow(client, stream, String(Number(period) + 1));

    const state = await loadPeriodState(stream, client);
    if (!state.archivedPeriods.includes(period)) {
      throw new AppError("Год " + period + " не закрыт — отменять нечего", 409, "not_archived");
    }
    const gate = canReopenPeriod(period, state);
    if (!gate.ok) {
      throw new AppError(gate.reason ?? "Отменить закрытие года нельзя", 409, "reopen_not_allowed");
    }

    await client.query("DELETE FROM number_archives WHERE stream = $1 AND period = $2", [stream, period]);
    await auditInTx(client, {
      userId: actor.id,
      userName: actor.name,
      action: "journal.reopen_period",
      entityType: "number_archive",
      entityId: stream + ":" + period,
      oldValue: { period, archived: true },
      newValue: { period, reason, reopenedBy: actor.name }
    });
    await client.query("COMMIT");
    return { period };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function listArchivedPeriods(stream = "incoming"): Promise<string[]> {
  const rows = await getDocflowDb().select().from(numberArchives).where(eq(numberArchives.stream, stream));
  return rows.map((r) => r.period).sort();
}

// ---------------- Справочники ----------------

export async function listCases(onlyActive = false): Promise<CaseNomenclatureRecord[]> {
  const db = getDocflowDb();
  const rows = onlyActive
    ? await db.select().from(caseNomenclature).where(eq(caseNomenclature.isActive, true))
    : await db.select().from(caseNomenclature);
  return rows
    .map((r) => ({ id: r.id, code: r.code, title: r.title, isActive: r.isActive, sortOrder: r.sortOrder }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code, "ru"));
}

export async function saveCase(
  input: { id?: string; code: string; title?: string; isActive?: boolean; sortOrder?: number },
  actor: Actor
): Promise<CaseNomenclatureRecord> {
  const db = getDocflowDb();
  const ts = now();
  const id = input.id ?? randomUUID();
  const values = {
    id,
    code: input.code,
    title: input.title ?? "",
    isActive: input.isActive !== false,
    sortOrder: input.sortOrder ?? 0,
    createdAt: ts,
    updatedAt: ts
  };
  // Дело и след — одна транзакция.
  await db.transaction(async (tx) => {
    await tx
      .insert(caseNomenclature)
      .values(values)
      .onConflictDoUpdate({
        target: caseNomenclature.id,
        set: {
          code: values.code,
          title: values.title,
          isActive: values.isActive,
          sortOrder: values.sortOrder,
          updatedAt: ts
        }
      });
    await insertAudit(
      {
        userId: actor.id,
        userName: actor.name,
        action: "journal.case.save",
        entityType: "case",
        entityId: id,
        newValue: values
      },
      tx
    );
  });
  return { id, code: values.code, title: values.title, isActive: values.isActive, sortOrder: values.sortOrder };
}

export async function listCorrespondents(onlyActive = false): Promise<CorrespondentRecord[]> {
  const db = getDocflowDb();
  const rows = onlyActive
    ? await db.select().from(correspondents).where(eq(correspondents.isActive, true))
    : await db.select().from(correspondents);
  return rows
    .map((r) => ({ id: r.id, name: r.name, shortName: r.shortName, inn: r.inn, isActive: r.isActive }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Находит или создаёт корреспондента по имени (вызывается при регистрации). */
export async function ensureCorrespondent(name: string, actor: Actor): Promise<CorrespondentRecord | null> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const db = getDocflowDb();
  const found = await db.select().from(correspondents).where(ilike(correspondents.name, trimmed)).limit(1);
  if (found[0]) {
    return {
      id: found[0].id,
      name: found[0].name,
      shortName: found[0].shortName,
      inn: found[0].inn,
      isActive: found[0].isActive
    };
  }
  const ts = now();
  const id = randomUUID();
  // Корреспондент создаётся вместе со следом: справочник не должен пополняться молча.
  await db.transaction(async (tx) => {
    await tx
      .insert(correspondents)
      .values({ id, name: trimmed, shortName: "", inn: "", isActive: true, createdAt: ts, updatedAt: ts });
    await insertAudit(
      {
        userId: actor.id,
        userName: actor.name,
        action: "journal.correspondent.create",
        entityType: "correspondent",
        entityId: id,
        newValue: { name: trimmed }
      },
      tx
    );
  });
  return { id, name: trimmed, shortName: "", inn: "", isActive: true };
}

export async function saveCorrespondent(
  input: { id?: string; name: string; shortName?: string; inn?: string; isActive?: boolean },
  actor: Actor
): Promise<CorrespondentRecord> {
  const db = getDocflowDb();
  const ts = now();
  const id = input.id ?? randomUUID();
  const values = {
    id,
    name: input.name,
    shortName: input.shortName ?? "",
    inn: input.inn ?? "",
    isActive: input.isActive !== false,
    createdAt: ts,
    updatedAt: ts
  };
  // Правка справочника и след — одна транзакция.
  await db.transaction(async (tx) => {
    await tx
      .insert(correspondents)
      .values(values)
      .onConflictDoUpdate({
        target: correspondents.id,
        set: {
          name: values.name,
          shortName: values.shortName,
          inn: values.inn,
          isActive: values.isActive,
          updatedAt: ts
        }
      });
    await insertAudit(
      {
        userId: actor.id,
        userName: actor.name,
        action: "journal.correspondent.save",
        entityType: "correspondent",
        entityId: id,
        newValue: values
      },
      tx
    );
  });
  return { id, name: values.name, shortName: values.shortName, inn: values.inn, isActive: values.isActive };
}

/** Сколько документов в каждом статусе — для сводки над журналом. */
export async function documentStatusCounts(): Promise<Record<string, number>> {
  const rows = await getDocflowDb()
    .select({ status: documents.status, n: countExpr })
    .from(documents)
    .groupBy(documents.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}