import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/index.js";
import { schema } from "./db/schema.js";
import { normalizeMessageId } from "./mail/parser.js";
import type {
  Account,
  AccountInput,
  AnalysisResult,
  AnalysisStatus,
  Attachment,
  Category,
  Draft,
  DraftAttachment,
  Email,
  EmailAddress,
  EmailView,
  Thread
} from "./types.js";

const { accounts, emails, attachments, analysisResults, deletedEmails, threads, drafts, settings } = schema;

function now(): string {
  return new Date().toISOString();
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

export function deleteAccount(id: string): void {
  getDb().delete(accounts).where(eq(accounts.id, id)).run();
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

export function emailExistsByMessageId(messageId: string): boolean {
  if (!messageId) return false;
  const db = getDb();
  if (db.select({ id: emails.id }).from(emails).where(eq(emails.messageId, messageId)).get()) return true;
  return !!db.select({ id: deletedEmails.id }).from(deletedEmails).where(eq(deletedEmails.messageId, messageId)).get();
}

export function knownUidsForAccount(accountId: string, folder: string): Set<string> {
  const db = getDb();
  const rows = db
    .select({ uid: emails.uid })
    .from(emails)
    .where(and(eq(emails.accountId, accountId), eq(emails.folder, folder)))
    .all();
  const deleted = db
    .select({ uid: deletedEmails.uid })
    .from(deletedEmails)
    .where(and(eq(deletedEmails.accountId, accountId), eq(deletedEmails.folder, folder)))
    .all();
  const set = new Set(rows.map((r) => r.uid));
  for (const d of deleted) set.add(d.uid);
  return set;
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
      externalNumber: e.externalNumber ?? null,
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

export function listEmailsWithAnalysis(filter: EmailListFilter = {}): EmailListItem[] {
  let items = listEmails({ accountId: filter.accountId, folder: filter.folder }).map((e) => ({
    ...e,
    analysis: getAnalysis(e.id)
  }));

  if (filter.categories && filter.categories.length > 0) {
    const set = new Set(filter.categories);
    items = items.filter((e) => (e.analysis?.category ? set.has(e.analysis.category) : false));
  }
  if (filter.minPriority) {
    items = items.filter((e) => (e.analysis?.priority ?? 0) >= (filter.minPriority ?? 0));
  }
  if (filter.tag) {
    const t = filter.tag.toLowerCase();
    items = items.filter((e) =>
      (e.analysis?.tags ?? []).some((x) => x.toLowerCase().includes(t))
    );
  }
  if (filter.hasEvent) {
    items = items.filter((e) => !!e.analysis?.eventDate);
  }
  if (filter.status) {
    items = items.filter((e) => e.analysisStatus === filter.status);
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
  if (filter.dateFrom) {
    items = items.filter((e) => (e.date?.slice(0, 10) ?? "") >= filter.dateFrom!);
  }
  if (filter.dateTo) {
    items = items.filter((e) => (e.date?.slice(0, 10) ?? "") <= filter.dateTo!);
  }
  if (filter.sendDateFrom) {
    items = items.filter((e) => (e.sendDate ?? "") >= filter.sendDateFrom!);
  }
  if (filter.sendDateTo) {
    items = items.filter((e) => (e.sendDate ?? "") <= filter.sendDateTo!);
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
  getDb().update(emails).set({ externalNumber, updatedAt: now() }).where(eq(emails.id, id)).run();
}

export function setNumberSource(id: string, attachmentId: string | null, page: number): void {
  getDb()
    .update(emails)
    .set({ numberSourceAttachmentId: attachmentId, numberSourcePage: page, updatedAt: now() })
    .where(eq(emails.id, id))
    .run();
}

export function setSendDate(id: string, sendDate: string | null): void {
  getDb().update(emails).set({ sendDate, updatedAt: now() }).where(eq(emails.id, id)).run();
}

export function setEmailsFolder(ids: string[], folder: string): void {
  if (ids.length === 0) return;
  getDb().update(emails).set({ folder, updatedAt: now() }).where(inArray(emails.id, ids)).run();
}

export function deleteEmails(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const rows = db.select().from(emails).where(inArray(emails.id, ids)).all();
  const ts = now();
  for (const r of rows) {
    db.insert(deletedEmails)
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
  db.delete(analysisResults).where(inArray(analysisResults.emailId, ids)).run();
  db.delete(attachments).where(inArray(attachments.emailId, ids)).run();
  return db.delete(emails).where(inArray(emails.id, ids)).run().changes;
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

export function setAttachmentDescription(id: string, description: string): void {
  getDb().update(attachments).set({ aiDescription: description }).where(eq(attachments.id, id)).run();
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
        eventDate: a.eventDate,
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
      eventDate: a.eventDate,
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
  getDb().update(threads).set({ lastMessageAt, updatedAt: now() }).where(eq(threads.id, id)).run();
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
  const id = randomUUID();
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
