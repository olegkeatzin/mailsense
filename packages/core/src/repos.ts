import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "./db/index.js";
import { schema } from "./db/schema.js";
import { getContext } from "./context.js";
import { logger } from "./logger.js";
import { normalizeMessageId } from "./mail/parser.js";
import type {
  Account,
  AccountInput,
  AnalysisResult,
  AnalysisStatus,
  Attachment,
  Category,
  DirectoryContact,
  Draft,
  DraftAttachment,
  Template,
  Email,
  EmailAddress,
  EmailView,
  Thread
} from "./types.js";

const {
  accounts,
  emails,
  attachments,
  analysisResults,
  deletedEmails,
  outOfRangeEmails,
  threads,
  drafts,
  templates,
  contacts,
  settings
} = schema;

function now(): string {
  return new Date().toISOString();
}

/**
 * Пустая строка (в том числе из пробелов) — это отсутствие значения, а не значение.
 * ⚠️ Модель охотно отвечает "event_date": "", а PATCH может прислать пустое поле:
 * раньше такая строка уходила в базу как «дата» и попадала в фильтр «есть дата события».
 */
function nullIfBlank(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}

function jparse<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------- Accounts ----------------

export function mapAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    protocol: row.protocol as Account["protocol"],
    host: row.host,
    port: row.port,
    tls: row.tls as Account["tls"],
    username: row.username,
    passwordEncrypted: row.passwordEncrypted,
    authType: row.authType as Account["authType"],
    settings: jparse<Account["settings"]>(row.settings, {}),
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpTls: row.smtpTls as Account["smtpTls"],
    smtpUsername: row.smtpUsername,
    smtpPasswordEncrypted: row.smtpPasswordEncrypted,
    smtpAuthType: row.smtpAuthType as Account["smtpAuthType"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function listAccounts(): Account[] {
  return getDb().select().from(accounts).all().map(mapAccount);
}

export function getAccount(id: string): Account | null {
  const row = getDb().select().from(accounts).where(eq(accounts.id, id)).get();
  return row ? mapAccount(row) : null;
}

export function countAccounts(): number {
  return getDb().select().from(accounts).all().length;
}

export function insertAccount(
  input: AccountInput,
  passwordEncrypted: string,
  smtpPasswordEncrypted: string | null = null
): Account {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.insert(accounts)
    .values({
      id,
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      tls: input.tls,
      username: input.username,
      passwordEncrypted,
      authType: input.authType,
      settings: JSON.stringify(input.settings ?? {}),
      smtpHost: input.smtpHost ?? null,
      smtpPort: input.smtpPort ?? null,
      smtpTls: input.smtpTls ?? null,
      smtpUsername: input.smtpUsername ?? null,
      smtpPasswordEncrypted: smtpPasswordEncrypted ?? null,
      smtpAuthType: input.smtpAuthType ?? null,
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getAccount(id)!;
}

export function updateAccount(
  id: string,
  input: AccountInput,
  passwordEncrypted?: string,
  smtpPasswordEncrypted?: string | null
): Account | null {
  const db = getDb();
  const existing = getAccount(id);
  if (!existing) return null;
  db.update(accounts)
    .set({
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      tls: input.tls,
      username: input.username,
      authType: input.authType,
      settings: JSON.stringify(input.settings ?? {}),
      smtpHost: input.smtpHost === undefined ? existing.smtpHost : input.smtpHost,
      smtpPort: input.smtpPort === undefined ? existing.smtpPort : input.smtpPort,
      smtpTls: input.smtpTls === undefined ? existing.smtpTls : input.smtpTls,
      smtpUsername: input.smtpUsername === undefined ? existing.smtpUsername : input.smtpUsername,
      smtpAuthType: input.smtpAuthType === undefined ? existing.smtpAuthType : input.smtpAuthType,
      ...(smtpPasswordEncrypted ? { smtpPasswordEncrypted } : {}),
      ...(passwordEncrypted ? { passwordEncrypted } : {}),
      updatedAt: now()
    })
    .where(eq(accounts.id, id))
    .run();
  return getAccount(id);
}

/**
 * Пути файлов вложений, привязанных к письмам (до удаления строк: после их уже не найти).
 */
function attachmentPathsForEmails(emailIds: string[]): string[] {
  if (!emailIds.length) return [];
  return getDb()
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .where(inArray(attachments.emailId, emailIds))
    .all()
    .map((r) => r.storagePath)
    .filter((p): p is string => !!p);
}

/**
 * Убирает файлы, на которые больше не ссылается НИ ОДНА строка attachments.
 *
 * ⚠️ Удаляем ПОСЛЕ коммита удаления записей и никогда не бросаем наружу: письмо уже удалено,
 * и «ничего не удалилось» из-за занятого файла хуже, чем оставшийся мусор. Ошибка — в журнал.
 * Проверка ссылок обязательна: две записи могут указывать на один путь, и снести файл,
 * нужный другой строке, значит потерять чужое вложение.
 */
function removeOrphanAttachmentFiles(paths: string[]): void {
  const unique = [...new Set(paths)];
  if (!unique.length) return;
  const db = getDb();
  for (const file of unique) {
    const still = db.select({ id: attachments.id }).from(attachments).where(eq(attachments.storagePath, file)).get();
    if (still) continue;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      // Файла уже нет — это не ошибка: цель достигнута.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ file, err: (err as Error).message }, "Не удалось удалить файл вложения");
      }
    }
    // Каталог письма после удаления вложений пуст — он тоже мусор. rmdir не тронет непустой.
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      /* не пуст, уже удалён или нет прав — не повод падать */
    }
  }
}

/** Каталоги файлов черновиков: живут отдельно от писем (<dataDir>/drafts/<id>). */
function removeDraftDirs(draftIds: string[]): void {
  if (!draftIds.length) return;
  let dataDir: string;
  try {
    dataDir = getContext().config.dataDir;
  } catch {
    logger.warn({ count: draftIds.length }, "Каталог данных недоступен — файлы черновиков не удалены");
    return;
  }
  for (const id of draftIds) {
    try {
      fs.rmSync(path.join(dataDir, "drafts", id), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ draftId: id, err: (err as Error).message }, "Не удалось удалить файлы черновика");
    }
  }
}

export function deleteAccount(id: string): void {
  const db = getDb();
  // Пути файлов и черновики собираем ДО удаления: после каскада строк их уже не найти.
  const emailIds = db
    .select({ id: emails.id })
    .from(emails)
    .where(eq(emails.accountId, id))
    .all()
    .map((r) => r.id);
  const files = attachmentPathsForEmails(emailIds);
  const draftIds = db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.accountId, id))
    .all()
    .map((r) => r.id);

  // Раньше черновики удалялись каскадом внешнего ключа drafts.account_id → accounts.id.
  // FK снят (черновик может ссылаться на серверный ящик, которого нет в локальной базе),
  // поэтому чистим их здесь — в одной транзакции с удалением ящика, иначе останутся сироты.
  db.transaction((tx) => {
    tx.delete(drafts).where(eq(drafts.accountId, id)).run();
    tx.delete(accounts).where(eq(accounts.id, id)).run();
  });

  // Файлы — после коммита: сбой уборки не должен откатывать удаление ящика.
  removeOrphanAttachmentFiles(files);
  removeDraftDirs(draftIds);
}

/** Точечно обновляет поле в settings-аккаунта (JSON), не затирая остальные. */
export function patchAccountSettings(id: string, patch: Record<string, unknown>): void {
  const existing = getAccount(id);
  if (!existing) return;
  const settings = { ...existing.settings, ...patch };
  getDb()
    .update(accounts)
    .set({ settings: JSON.stringify(settings), updatedAt: now() })
    .where(eq(accounts.id, id))
    .run();
}

export function listAccountIds(): string[] {
  return getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .all()
    .map((r) => r.id);
}

// ---------------- Emails ----------------

function mapEmail(row: typeof emails.$inferSelect): Email {
  return {
    id: row.id,
    accountId: row.accountId,
    folder: row.folder,
    uid: row.uid,
    messageId: row.messageId,
    subject: row.subject,
    from: jparse<EmailAddress | null>(row.from, null),
    to: jparse<EmailAddress[]>(row.to, []),
    date: row.date,
    externalNumber: row.externalNumber,
    numberSourceAttachmentId: row.numberSourceAttachmentId,
    numberSourcePage: row.numberSourcePage,
    sendDate: row.sendDate,
    threadId: row.threadId,
    cc: jparse<EmailAddress[]>(row.cc, []),
    replyTo: jparse<EmailAddress[]>(row.replyTo, []),
    inReplyTo: row.inReplyTo,
    references: jparse<string[]>(row.references, []),
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    headers: jparse<Record<string, unknown>>(row.headers, {}),
    analysisStatus: row.analysisStatus as AnalysisStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Есть ли письмо с таким Message-ID. Надгробия удалённых писем учитываются,
 * когда includeDeleted=false (авто-скан не воскрешает удалённое). Ручной скан
 * (`includeDeleted=true`) игнорирует их, чтобы письмо можно было скачать заново.
 *
 * ⚠️ **`accountId` обязателен при сканировании ящика.** Без него проверка идёт по всей
 * базе, и тогда копия письма в «Отправленных» отправителя «отменяет» то же письмо
 * в ящике получателя: скан считает его дубликатом и не сохраняет. Из-за этого письма,
 * отправленные системой (поручения, письма руководителю), не появлялись у адресатов.
 * Параметр необязателен только ради обратной совместимости вызовов без ящика.
 */
export function emailExistsByMessageId(messageId: string, includeDeleted = false, accountId?: string): boolean {
  if (!messageId) return false;
  const db = getDb();
  const byMessageId = eq(emails.messageId, messageId);
  const inAccount = accountId ? and(byMessageId, eq(emails.accountId, accountId)) : byMessageId;
  if (db.select({ id: emails.id }).from(emails).where(inAccount).get()) return true;
  if (includeDeleted) return false;
  const tombstone = eq(deletedEmails.messageId, messageId);
  const tombstoneInAccount = accountId ? and(tombstone, eq(deletedEmails.accountId, accountId)) : tombstone;
  return !!db.select({ id: deletedEmails.id }).from(deletedEmails).where(tombstoneInAccount).get();
}

/**
 * Уже известные UID папки. Надгробия удалённых писем добавляются по умолчанию,
 * чтобы авто-скан не тянул их повторно; ручной скан (`includeDeleted=true`)
 * считает их неизвестными и забирает заново.
 */
export function knownUidsForAccount(accountId: string, folder: string, includeDeleted = false): Set<string> {
  const db = getDb();
  const rows = db
    .select({ uid: emails.uid })
    .from(emails)
    .where(and(eq(emails.accountId, accountId), eq(emails.folder, folder)))
    .all();
  const set = new Set(rows.map((r) => r.uid));
  if (includeDeleted) return set;
  const deleted = db
    .select({ uid: deletedEmails.uid })
    .from(deletedEmails)
    .where(and(eq(deletedEmails.accountId, accountId), eq(deletedEmails.folder, folder)))
    .all();
  for (const d of deleted) set.add(d.uid);
  return set;
}

/**
 * Запоминает письмо, отсечённое диапазоном дат: UID и дату с сервера.
 * Следующий скан это тело уже не скачает (POP3-коннектор серверного поиска по датам не имеет).
 */
export function rememberOutOfRange(accountId: string, folder: string, uid: string, serverDate: string | null): void {
  getDb()
    .insert(outOfRangeEmails)
    .values({ accountId, folder, uid, serverDate: serverDate ?? null, createdAt: now() })
    .onConflictDoUpdate({
      target: [outOfRangeEmails.accountId, outOfRangeEmails.folder, outOfRangeEmails.uid],
      set: { serverDate: serverDate ?? null }
    })
    .run();
}

/** Записи «вне диапазона» папки: UID и дата, которую скан разобрал из письма. */
export function listOutOfRange(accountId: string, folder: string): Array<{ uid: string; serverDate: string | null }> {
  return getDb()
    .select({ uid: outOfRangeEmails.uid, serverDate: outOfRangeEmails.serverDate })
    .from(outOfRangeEmails)
    .where(and(eq(outOfRangeEmails.accountId, accountId), eq(outOfRangeEmails.folder, folder)))
    .all();
}

/** Убирает запись: письмо сохранено (или стало известно другим путём). */
export function clearOutOfRange(accountId: string, folder: string, uid: string): void {
  getDb()
    .delete(outOfRangeEmails)
    .where(
      and(
        eq(outOfRangeEmails.accountId, accountId),
        eq(outOfRangeEmails.folder, folder),
        eq(outOfRangeEmails.uid, uid)
      )
    )
    .run();
}

/** Убирает надгробия письма — после того как оно снова сохранено из ящика. */
export function clearDeletedEmail(accountId: string, folder: string, uid: string, messageId: string): void {
  const db = getDb();
  db.delete(deletedEmails)
    .where(
      and(
        eq(deletedEmails.accountId, accountId),
        sql`(${deletedEmails.uid} = ${uid} OR ${deletedEmails.messageId} = ${messageId})`
      )
    )
    .run();
}

export function insertEmail(e: {
  accountId: string;
  folder: string;
  uid: string;
  messageId: string;
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc?: EmailAddress[];
  replyTo?: EmailAddress[];
  inReplyTo?: string | null;
  references?: string[];
  date: string | null;
  externalNumber?: string | null;
  threadId?: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, unknown>;
  analysisStatus?: AnalysisStatus;
}): Email {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.insert(emails)
    .values({
      id,
      accountId: e.accountId,
      folder: e.folder,
      uid: e.uid,
      messageId: e.messageId,
      subject: e.subject,
      from: JSON.stringify(e.from ?? null),
      to: JSON.stringify(e.to ?? []),
      cc: JSON.stringify(e.cc ?? []),
      replyTo: JSON.stringify(e.replyTo ?? []),
      inReplyTo: e.inReplyTo ?? null,
      references: JSON.stringify(e.references ?? []),
      date: e.date,
      externalNumber: nullIfBlank(e.externalNumber),
      numberSourceAttachmentId: null,
      numberSourcePage: 1,
      sendDate: null,
      threadId: e.threadId ?? null,
      bodyText: e.bodyText,
      bodyHtml: e.bodyHtml,
      headers: JSON.stringify(e.headers ?? {}),
      analysisStatus: e.analysisStatus ?? "pending",
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return mapEmail(getDb().select().from(emails).where(eq(emails.id, id)).get()!);
}

export function getEmail(id: string): Email | null {
  const row = getDb().select().from(emails).where(eq(emails.id, id)).get();
  return row ? mapEmail(row) : null;
}

export function listEmails(opts: { accountId?: string; folder?: string } = {}): Email[] {
  const conditions = [];
  if (opts.accountId) conditions.push(eq(emails.accountId, opts.accountId));
  if (opts.folder) conditions.push(eq(emails.folder, opts.folder));
  const q = getDb().select().from(emails).orderBy(desc(emails.date));
  const rows = conditions.length
    ? q.where(and(...conditions)).all()
    : q.all();
  return rows.map(mapEmail);
}

export interface EmailListItem extends Email {
  analysis: AnalysisResult | null;
}

export interface EmailListFilter {
  accountId?: string;
  folder?: string;
  categories?: Category[];
  minPriority?: number;
  tag?: string;
  hasEvent?: boolean;
  status?: AnalysisStatus;
  q?: string;
  from?: string[];
  to?: string[];
  externalNumber?: string[];
  dateFrom?: string;
  dateTo?: string;
  sendDateFrom?: string;
  sendDateTo?: string;
  sortBy?: "date" | "priority";
  sortDir?: "asc" | "desc";
}

/**
 * Условия, которые можно считать в SQL. Вынесены отдельно, потому что тот же
 * набор нужен и «ленте переписки» (listEmailsWithAnalysisByThreadIds).
 *
 * ⚠️ Фильтры по тексту (tag, q, from, to, externalNumber) сюда НЕ переносятся:
 * SQLite складывает регистр только по ASCII, поэтому «иван» перестал бы находить
 * «Иванов» и «договор» — «Договор». Это уже стоило одного бага в каталоге
 * (см. searchContactsCache).
 */
function emailListConditions(filter: EmailListFilter) {
  const conditions = [];
  if (filter.accountId) conditions.push(eq(emails.accountId, filter.accountId));
  if (filter.folder) conditions.push(eq(emails.folder, filter.folder));
  if (filter.status) conditions.push(eq(emails.analysisStatus, filter.status));
  if (filter.categories && filter.categories.length > 0) {
    conditions.push(inArray(analysisResults.category, filter.categories));
  }
  if (filter.minPriority) conditions.push(gte(analysisResults.priority, filter.minPriority));
  // Пустая строка — это «даты нет»: в базе могли остаться записи, сделанные до
  // нормализации, и isNotNull их бы посчитал датой.
  if (filter.hasEvent) {
    conditions.push(and(isNotNull(analysisResults.eventDate), ne(analysisResults.eventDate, ""))!);
  }
  // Даты — обычные ISO-строки, поэтому сравнение в SQL совпадает с прежним
  // сравнением в JS. Без даты письмо не проходит только нижнюю границу —
  // как и раньше: пустая строка меньше любой даты.
  if (filter.dateFrom) {
    conditions.push(sql`substr(coalesce(${emails.date}, ''), 1, 10) >= ${filter.dateFrom}`);
  }
  if (filter.dateTo) {
    conditions.push(sql`substr(coalesce(${emails.date}, ''), 1, 10) <= ${filter.dateTo}`);
  }
  if (filter.sendDateFrom) {
    conditions.push(sql`coalesce(${emails.sendDate}, '') >= ${filter.sendDateFrom}`);
  }
  if (filter.sendDateTo) {
    conditions.push(sql`coalesce(${emails.sendDate}, '') <= ${filter.sendDateTo}`);
  }
  return conditions;
}

/**
 * Письма вместе с результатом анализа.
 *
 * ⚠️ Раньше на каждое письмо делался отдельный запрос за анализом (N+1): ящик
 * на 500 писем — 501 запрос на каждое открытие списка. Теперь это один JOIN;
 * число запросов не зависит от размера ящика.
 */
export function listEmailsWithAnalysis(filter: EmailListFilter = {}): EmailListItem[] {
  const conditions = emailListConditions(filter);
  const rows = getDb()
    .select({ email: emails, analysis: analysisResults })
    .from(emails)
    .leftJoin(analysisResults, eq(analysisResults.emailId, emails.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(emails.date))
    .all();

  // id анализа пуст, если JOIN не нашёл строку: у письма ещё нет результата.
  let items: EmailListItem[] = rows.map((r) => ({
    ...mapEmail(r.email),
    analysis: r.analysis && r.analysis.id ? mapAnalysis(r.analysis) : null
  }));

  if (filter.tag) {
    const t = filter.tag.toLowerCase();
    items = items.filter((e) =>
      (e.analysis?.tags ?? []).some((x) => x.toLowerCase().includes(t))
    );
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    items = items.filter(
      (e) =>
        e.subject.toLowerCase().includes(q) ||
        e.bodyText.toLowerCase().includes(q) ||
        (e.externalNumber ?? "").toLowerCase().includes(q) ||
        (e.from?.name ?? "").toLowerCase().includes(q) ||
        (e.from?.address ?? "").toLowerCase().includes(q)
    );
  }
  if (filter.from && filter.from.length > 0) {
    const fs = filter.from.map((f) => f.toLowerCase());
    items = items.filter((e) =>
      fs.some(
        (f) =>
          (e.from?.name ?? "").toLowerCase().includes(f) ||
          (e.from?.address ?? "").toLowerCase().includes(f)
      )
    );
  }
  if (filter.to && filter.to.length > 0) {
    const ts = filter.to.map((t) => t.toLowerCase());
    items = items.filter((e) =>
      e.to.some((a) =>
        ts.some(
          (t) => (a.address ?? "").toLowerCase().includes(t) || (a.name ?? "").toLowerCase().includes(t)
        )
      )
    );
  }
  if (filter.externalNumber && filter.externalNumber.length > 0) {
    const ns = filter.externalNumber.map((n) => n.toLowerCase());
    items = items.filter((e) => ns.some((n) => (e.externalNumber ?? "").toLowerCase().includes(n)));
  }
  const dir = filter.sortDir === "asc" ? 1 : -1;
  items.sort((a, b) => {
    if (filter.sortBy === "priority") {
      return dir * ((a.analysis?.priority ?? 0) - (b.analysis?.priority ?? 0));
    }
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return dir * (da - db);
  });

  return items;
}

/**
 * Все письма указанных бесед, без учёта папки — для сквозной ленты переписки.
 * Анализ подтягивается тем же JOIN: иначе лента переписки снова давала N+1.
 */
export function listEmailsWithAnalysisByThreadIds(threadIds: string[]): EmailListItem[] {
  if (!threadIds.length) return [];
  return getDb()
    .select({ email: emails, analysis: analysisResults })
    .from(emails)
    .leftJoin(analysisResults, eq(analysisResults.emailId, emails.id))
    .where(inArray(emails.threadId, threadIds))
    .orderBy(emails.date)
    .all()
    .map((r) => ({
      ...mapEmail(r.email),
      analysis: r.analysis && r.analysis.id ? mapAnalysis(r.analysis) : null
    }));
}

export function setEmailStatus(id: string, status: AnalysisStatus): void {
  getDb()
    .update(emails)
    .set({ analysisStatus: status, updatedAt: now() })
    .where(eq(emails.id, id))
    .run();
}

export function setEmailFolder(id: string, folder: string): void {
  getDb().update(emails).set({ folder, updatedAt: now() }).where(eq(emails.id, id)).run();
}

export function setExternalNumber(id: string, externalNumber: string | null): void {
  getDb()
    .update(emails)
    .set({ externalNumber: nullIfBlank(externalNumber), updatedAt: now() })
    .where(eq(emails.id, id))
    .run();
}

export function setNumberSource(id: string, attachmentId: string | null, page: number): void {
  getDb()
    .update(emails)
    .set({ numberSourceAttachmentId: attachmentId, numberSourcePage: page, updatedAt: now() })
    .where(eq(emails.id, id))
    .run();
}

export function setSendDate(id: string, sendDate: string | null): void {
  getDb()
    .update(emails)
    .set({ sendDate: nullIfBlank(sendDate), updatedAt: now() })
    .where(eq(emails.id, id))
    .run();
}

export function setEmailsFolder(ids: string[], folder: string): void {
  if (ids.length === 0) return;
  getDb().update(emails).set({ folder, updatedAt: now() }).where(inArray(emails.id, ids)).run();
}

/**
 * Удаляет письма: надгробия, анализ, вложения и сами письма — одним изменением.
 *
 * ⚠️ Раньше это были четыре независимых действия без транзакции. Сбой между ними
 * (например, на удалении вложений) оставлял половинчатое состояние: надгробие уже
 * записано, анализ удалён, а письмо осталось — при этом авто-скан считает его
 * удалённым и больше никогда не скачает, а в интерфейсе оно висит без анализа.
 */
export function deleteEmails(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  // Пути собираем до удаления строк: потом их уже не найти.
  const files = attachmentPathsForEmails(ids);
  const changed = db.transaction((tx) => {
    const rows = tx.select().from(emails).where(inArray(emails.id, ids)).all();
    const ts = now();
    for (const r of rows) {
      tx.insert(deletedEmails)
        .values({
          id: randomUUID(),
          accountId: r.accountId,
          folder: r.folder,
          uid: r.uid,
          messageId: r.messageId,
          deletedAt: ts
        })
        .onConflictDoNothing()
        .run();
    }
    tx.delete(analysisResults).where(inArray(analysisResults.emailId, ids)).run();
    tx.delete(attachments).where(inArray(attachments.emailId, ids)).run();
    return tx.delete(emails).where(inArray(emails.id, ids)).run().changes;
  });
  // Файлы убираем после коммита: ошибка удаления файла не откатывает удаление писем.
  removeOrphanAttachmentFiles(files);
  return changed;
}

// ---------------- Attachments ----------------

export function mapAttachment(row: typeof attachments.$inferSelect): Attachment {
  return {
    id: row.id,
    emailId: row.emailId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    storagePath: row.storagePath,
    extractedText: row.extractedText,
    aiDescription: row.aiDescription,
    contentId: row.contentId,
    kind: row.kind as Attachment["kind"],
    handled: row.handled,
    createdAt: row.createdAt
  };
}

export function insertAttachment(a: {
  emailId: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string | null;
  extractedText: string | null;
  contentId: string | null;
  kind: string;
  handled: boolean;
}): Attachment {
  const db = getDb();
  const id = randomUUID();
  db.insert(attachments)
    .values({
      id,
      emailId: a.emailId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      storagePath: a.storagePath,
      extractedText: a.extractedText,
      aiDescription: null,
      contentId: a.contentId,
      kind: a.kind,
      handled: a.handled,
      createdAt: now()
    })
    .run();
  return mapAttachment(db.select().from(attachments).where(eq(attachments.id, id)).get()!);
}

export function listAttachments(emailId: string): Attachment[] {
  return getDb()
    .select()
    .from(attachments)
    .where(eq(attachments.emailId, emailId))
    .all()
    .map(mapAttachment);
}

/**
 * Количество вложений для каждого письма — одним запросом.
 *
 * ⚠️ Нужен там, где список писем длинный (например «Входящие на регистрацию»):
 * звать listAttachments на каждое письмо — это N+1, до сотен запросов на один
 * вызов. Писем без вложений в мапе нет — вызывающий приводит отсутствие к нулю.
 */
export function countAttachmentsByEmail(emailIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (emailIds.length === 0) return counts;
  const rows = getDb()
    .select({ emailId: attachments.emailId, count: sql<number>`count(*)` })
    .from(attachments)
    .where(inArray(attachments.emailId, emailIds))
    .groupBy(attachments.emailId)
    .all();
  for (const r of rows) counts.set(r.emailId, Number(r.count));
  return counts;
}

export function setAttachmentDescription(id: string, description: string): void {
  getDb().update(attachments).set({ aiDescription: description }).where(eq(attachments.id, id)).run();
}

/** Сохраняет распознанный текст вложения (OCR/извлечённый), чтобы он был виден в UI. */
export function setAttachmentText(id: string, text: string): void {
  getDb().update(attachments).set({ extractedText: text }).where(eq(attachments.id, id)).run();
}

// ---------------- Analysis results ----------------

function mapAnalysis(row: typeof analysisResults.$inferSelect): AnalysisResult {
  return {
    id: row.id,
    emailId: row.emailId,
    summary: row.summary,
    tags: jparse<string[]>(row.tags, []),
    priority: row.priority,
    urgent: row.urgent,
    eventDate: row.eventDate,
    category: row.category as Category,
    rawResponse: row.rawResponse,
    attachments: jparse<{ name: string; description: string }[]>(row.attachments, []),
    modelUsed: row.modelUsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function getAnalysis(emailId: string): AnalysisResult | null {
  const row = getDb().select().from(analysisResults).where(eq(analysisResults.emailId, emailId)).get();
  return row ? mapAnalysis(row) : null;
}

export function upsertAnalysis(a: {
  emailId: string;
  summary: string;
  tags: string[];
  priority: number;
  urgent: boolean;
  eventDate: string | null;
  category: Category;
  rawResponse: string;
  modelUsed: string;
  attachments?: { name: string; description: string }[];
}): AnalysisResult {
  const db = getDb();
  const ts = now();
  const existing = getAnalysis(a.emailId);
  if (existing) {
    db.update(analysisResults)
      .set({
        summary: a.summary,
        tags: JSON.stringify(a.tags),
        priority: a.priority,
        urgent: a.urgent,
        eventDate: nullIfBlank(a.eventDate),
        category: a.category,
        rawResponse: a.rawResponse,
        modelUsed: a.modelUsed,
        attachments: JSON.stringify(a.attachments ?? []),
        updatedAt: ts
      })
      .where(eq(analysisResults.emailId, a.emailId))
      .run();
    return getAnalysis(a.emailId)!;
  }
  db.insert(analysisResults)
    .values({
      id: randomUUID(),
      emailId: a.emailId,
      summary: a.summary,
      tags: JSON.stringify(a.tags),
      priority: a.priority,
      urgent: a.urgent,
      eventDate: nullIfBlank(a.eventDate),
      category: a.category,
      rawResponse: a.rawResponse,
      modelUsed: a.modelUsed,
      attachments: JSON.stringify(a.attachments ?? []),
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getAnalysis(a.emailId)!;
}

export function getEmailView(id: string): EmailView | null {
  const email = getEmail(id);
  if (!email) return null;
  return {
    ...email,
    attachments: listAttachments(id),
    analysis: getAnalysis(id)
  };
}

// ---------------- Threads ----------------

function mapThread(row: typeof threads.$inferSelect): Thread {
  return {
    id: row.id,
    accountId: row.accountId,
    normalizedSubject: row.normalizedSubject,
    rootMessageId: row.rootMessageId,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function getThread(id: string): Thread | null {
  const row = getDb().select().from(threads).where(eq(threads.id, id)).get();
  return row ? mapThread(row) : null;
}

export function findThreadByRoot(accountId: string, rootMessageId: string): Thread | null {
  const row = getDb()
    .select()
    .from(threads)
    .where(and(eq(threads.accountId, accountId), eq(threads.rootMessageId, rootMessageId)))
    .get();
  return row ? mapThread(row) : null;
}

export function createThread(accountId: string, rootMessageId: string | null, normalizedSubject: string): Thread {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.insert(threads)
    .values({
      id,
      accountId,
      normalizedSubject,
      rootMessageId,
      lastMessageAt: ts,
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getThread(id)!;
}

export function touchThread(id: string, lastMessageAt: string): void {
  const existing = getThread(id);
  if (!existing) return;
  const next =
    lastMessageAt && (!existing.lastMessageAt || lastMessageAt > existing.lastMessageAt)
      ? lastMessageAt
      : existing.lastMessageAt;
  getDb().update(threads).set({ lastMessageAt: next, updatedAt: now() }).where(eq(threads.id, id)).run();
}

export function updateThreadRoot(id: string, rootMessageId: string | null): void {
  getDb().update(threads).set({ rootMessageId, updatedAt: now() }).where(eq(threads.id, id)).run();
}

/** Самая свежая беседа аккаунта с такой нормализованной темой (для склейки ответов без родителя в БД). */
export function findThreadByNormalizedSubject(accountId: string, normalizedSubject: string): Thread | null {
  if (!normalizedSubject) return null;
  const row = getDb()
    .select()
    .from(threads)
    .where(and(eq(threads.accountId, accountId), eq(threads.normalizedSubject, normalizedSubject)))
    .orderBy(desc(threads.updatedAt))
    .get();
  return row ? mapThread(row) : null;
}

/** Переносит все письма из одной беседы в другую. */
export function reassignEmailsThread(fromThreadId: string, toThreadId: string): number {
  if (!fromThreadId || fromThreadId === toThreadId) return 0;
  return getDb()
    .update(emails)
    .set({ threadId: toThreadId, updatedAt: now() })
    .where(eq(emails.threadId, fromThreadId))
    .run().changes;
}

export function deleteThread(id: string): void {
  getDb().delete(threads).where(eq(threads.id, id)).run();
}

/** Полный сброс бесед аккаунта (перед пересборкой). */
export function clearThreadsForAccount(accountId: string): void {
  const db = getDb();
  db.update(emails).set({ threadId: null, updatedAt: now() }).where(eq(emails.accountId, accountId)).run();
  db.delete(threads).where(eq(threads.accountId, accountId)).run();
}

/** Письма, ссылающиеся на указанный Message-ID (In-Reply-To / References). */
export function findEmailsReferencing(accountId: string, messageId: string): Email[] {
  const norm = normalizeMessageId(messageId);
  if (!norm) return [];
  const like = "%" + norm + "%";
  const rows = getDb()
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.accountId, accountId),
        sql`(${emails.inReplyTo} = ${norm} OR ${emails.references} LIKE ${like})`
      )
    )
    .all();
  return rows.map(mapEmail);
}

/** Письма, помеченные «Готово», но без результата анализа (кроме «Отправленных»). */
export function resetReadyWithoutAnalysis(): number {
  const db = getDb();
  const rows = db
    .select({ id: emails.id, folder: emails.folder })
    .from(emails)
    .where(eq(emails.analysisStatus, "ready"))
    .all();
  let n = 0;
  for (const r of rows) {
    if (r.folder === "Sent") continue;
    if (!getAnalysis(r.id)) {
      setEmailStatus(r.id, "pending");
      n++;
    }
  }
  return n;
}

/**
 * Одноразовая чистка данных: пустая строка (в том числе из пробелов) в
 * необязательном поле — это отсутствие значения.
 *
 * Нормализация при записи (nullIfBlank) новые такие значения не создаёт, но в
 * базе остаются записанные раньше. Фильтры их уже игнорируют, однако следующий
 * фильтр может и не знать про эту особенность — поэтому чистим сами данные.
 * Возвращает число исправленных записей.
 */
export function normalizeBlankValues(): number {
  const db = getDb();
  const ts = now();
  let fixed = 0;

  // Дата события: пустая строка считалась датой в фильтре «есть дата события».
  fixed += db
    .update(analysisResults)
    .set({ eventDate: null, updatedAt: ts })
    .where(and(isNotNull(analysisResults.eventDate), sql`trim(${analysisResults.eventDate}) = ''`))
    .run().changes;

  // Внешний номер письма.
  fixed += db
    .update(emails)
    .set({ externalNumber: null, updatedAt: ts })
    .where(and(isNotNull(emails.externalNumber), sql`trim(${emails.externalNumber}) = ''`))
    .run().changes;

  // Дата отправки.
  fixed += db
    .update(emails)
    .set({ sendDate: null, updatedAt: ts })
    .where(and(isNotNull(emails.sendDate), sql`trim(${emails.sendDate}) = ''`))
    .run().changes;

  return fixed;
}

export function listThreads(accountId: string): Thread[] {
  return getDb()
    .select()
    .from(threads)
    .where(eq(threads.accountId, accountId))
    .orderBy(desc(threads.updatedAt))
    .all()
    .map(mapThread);
}

export function setEmailThread(emailId: string, threadId: string | null): void {
  getDb().update(emails).set({ threadId, updatedAt: now() }).where(eq(emails.id, emailId)).run();
}

/** Найти письмо по Message-ID в рамках аккаунта (для трединга). Устойчив к скобкам. */
export function findEmailByMessageId(accountId: string, messageId: string): Email | null {
  if (!messageId) return null;
  const norm = normalizeMessageId(messageId);
  const variants = [norm, "<" + norm + ">"];
  for (const v of variants) {
    const row = getDb()
      .select()
      .from(emails)
      .where(and(eq(emails.accountId, accountId), eq(emails.messageId, v)))
      .get();
    if (row) return mapEmail(row);
  }
  return null;
}

// ---------------- Drafts ----------------

function mapDraft(row: typeof drafts.$inferSelect): Draft {
  return {
    id: row.id,
    accountId: row.accountId,
    to: jparse<EmailAddress[]>(row.to, []),
    cc: jparse<EmailAddress[]>(row.cc, []),
    bcc: jparse<EmailAddress[]>(row.bcc, []),
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachments: jparse<DraftAttachment[]>(row.attachments, []),
    inReplyToEmailId: row.inReplyToEmailId,
    inReplyToMessageId: row.inReplyToMessageId,
    references: jparse<string[]>(row.references, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function listDrafts(accountId?: string): Draft[] {
  const q = getDb().select().from(drafts).orderBy(desc(drafts.updatedAt));
  const rows = accountId ? q.where(eq(drafts.accountId, accountId)).all() : q.all();
  return rows.map(mapDraft);
}

export function getDraft(id: string): Draft | null {
  const row = getDb().select().from(drafts).where(eq(drafts.id, id)).get();
  return row ? mapDraft(row) : null;
}

export function insertDraft(d: {
  /** Идентификатор можно задать заранее: по нему раскладываются файлы вложений. */
  id?: string;
  accountId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: DraftAttachment[];
  inReplyToEmailId?: string | null;
  inReplyToMessageId?: string | null;
  references?: string[];
}): Draft {
  const db = getDb();
  const id = d.id ?? randomUUID();
  const ts = now();
  db.insert(drafts)
    .values({
      id,
      accountId: d.accountId,
      to: JSON.stringify(d.to ?? []),
      cc: JSON.stringify(d.cc ?? []),
      bcc: JSON.stringify(d.bcc ?? []),
      subject: d.subject,
      bodyText: d.bodyText,
      bodyHtml: d.bodyHtml ?? null,
      attachments: JSON.stringify(d.attachments ?? []),
      inReplyToEmailId: d.inReplyToEmailId ?? null,
      inReplyToMessageId: d.inReplyToMessageId ?? null,
      references: JSON.stringify(d.references ?? []),
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getDraft(id)!;
}

export function updateDraft(
  id: string,
  d: Partial<{
    to: EmailAddress[];
    cc: EmailAddress[];
    bcc: EmailAddress[];
    subject: string;
    bodyText: string;
    bodyHtml: string | null;
    attachments: DraftAttachment[];
    inReplyToEmailId: string | null;
    inReplyToMessageId: string | null;
    references: string[];
  }>
): Draft | null {
  const existing = getDraft(id);
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: now() };
  if (d.to !== undefined) set.to = JSON.stringify(d.to);
  if (d.cc !== undefined) set.cc = JSON.stringify(d.cc);
  if (d.bcc !== undefined) set.bcc = JSON.stringify(d.bcc);
  if (d.subject !== undefined) set.subject = d.subject;
  if (d.bodyText !== undefined) set.bodyText = d.bodyText;
  if (d.bodyHtml !== undefined) set.bodyHtml = d.bodyHtml;
  if (d.attachments !== undefined) set.attachments = JSON.stringify(d.attachments);
  if (d.inReplyToEmailId !== undefined) set.inReplyToEmailId = d.inReplyToEmailId;
  if (d.inReplyToMessageId !== undefined) set.inReplyToMessageId = d.inReplyToMessageId;
  if (d.references !== undefined) set.references = JSON.stringify(d.references);
  getDb().update(drafts).set(set).where(eq(drafts.id, id)).run();
  return getDraft(id);
}

export function deleteDraft(id: string): void {
  getDb().delete(drafts).where(eq(drafts.id, id)).run();
}

// ---------------- Templates ----------------

function mapTemplate(row: typeof templates.$inferSelect): Template {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** Шаблоны: общие (accountId=null) + шаблоны конкретного аккаунта. */
export function listTemplates(accountId?: string): Template[] {
  const db = getDb();
  const rows = accountId
    ? db
        .select()
        .from(templates)
        .where(or(eq(templates.accountId, accountId), isNull(templates.accountId)))
        .all()
    : db.select().from(templates).all();
  return rows.map(mapTemplate).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

export function getTemplate(id: string): Template | null {
  const row = getDb().select().from(templates).where(eq(templates.id, id)).get();
  return row ? mapTemplate(row) : null;
}

export function insertTemplate(t: {
  accountId?: string | null;
  name: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
}): Template {
  const db = getDb();
  const id = randomUUID();
  const ts = now();
  db.insert(templates)
    .values({
      id,
      accountId: t.accountId ?? null,
      name: t.name,
      subject: t.subject ?? "",
      bodyText: t.bodyText ?? "",
      bodyHtml: t.bodyHtml ?? null,
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getTemplate(id)!;
}

export function updateTemplate(
  id: string,
  patch: Partial<{ accountId: string | null; name: string; subject: string; bodyText: string; bodyHtml: string | null }>
): Template | null {
  const existing = getTemplate(id);
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: now() };
  if (patch.accountId !== undefined) set.accountId = patch.accountId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.subject !== undefined) set.subject = patch.subject;
  if (patch.bodyText !== undefined) set.bodyText = patch.bodyText;
  if (patch.bodyHtml !== undefined) set.bodyHtml = patch.bodyHtml;
  getDb().update(templates).set(set).where(eq(templates.id, id)).run();
  return getTemplate(id);
}

export function deleteTemplate(id: string): void {
  getDb().delete(templates).where(eq(templates.id, id)).run();
}

// ---------------- Contacts (каталог LDAP) ----------------

function mapContact(row: typeof contacts.$inferSelect): DirectoryContact {
  return {
    dn: row.dn,
    login: row.login,
    displayName: row.displayName,
    mail: row.mail,
    title: row.title,
    department: row.department,
    phone: row.phone,
    updatedAt: row.updatedAt
  };
}

/** Пакетный upsert контактов каталога (по DN). */
export function upsertContacts(list: DirectoryContact[]): void {
  if (!list.length) return;
  const db = getDb();
  const ts = now();
  db.transaction((tx) => {
    for (const c of list) {
      const values = {
        login: c.login ?? "",
        displayName: c.displayName ?? "",
        mail: c.mail ?? "",
        title: c.title ?? "",
        department: c.department ?? "",
        phone: c.phone ?? "",
        updatedAt: ts
      };
      tx.insert(contacts)
        .values({ dn: c.dn, ...values })
        .onConflictDoUpdate({ target: contacts.dn, set: values })
        .run();
    }
  });
}

/**
 * Поиск по кэшу каталога: имя/почта/логин/отдел.
 *
 * Сравнение идёт в JS, а не через SQL lower(): SQLite понимает только ASCII,
 * поэтому «иван» не находил «Иванов» — русские имена в адресной книге не искались.
 * Кэш каталога невелик (тысячи записей), так что фильтрация в памяти допустима.
 */
export function searchContactsCache(q: string, limit = 25): DirectoryContact[] {
  const needle = (q ?? "").trim().toLowerCase();
  const rows = getDb().select().from(contacts).all().map(mapContact);
  if (!needle) return rows.slice(0, limit);
  const has = (v: string | null | undefined): boolean => (v ?? "").toLowerCase().includes(needle);
  return rows
    .filter((c) => has(c.displayName) || has(c.mail) || has(c.login) || has(c.department))
    .slice(0, limit);
}

export function listContacts(limit = 500): DirectoryContact[] {
  return getDb().select().from(contacts).limit(limit).all().map(mapContact);
}

export function countContacts(): number {
  return getDb().select().from(contacts).all().length;
}

// ---------------- Settings ----------------

export function getSetting(key: string): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function listSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of getDb().select().from(settings).all()) out[row.key] = row.value;
  return out;
}
