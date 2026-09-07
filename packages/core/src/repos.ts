import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/index.js";
import { schema } from "./db/schema.js";
import type {
  Account,
  AccountInput,
  AnalysisResult,
  AnalysisStatus,
  Attachment,
  Category,
  Email,
  EmailAddress,
  EmailView
} from "./types.js";

const { accounts, emails, attachments, analysisResults, deletedEmails, settings } = schema;

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

export function insertAccount(input: AccountInput, passwordEncrypted: string): Account {
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
      createdAt: ts,
      updatedAt: ts
    })
    .run();
  return getAccount(id)!;
}

export function updateAccount(id: string, input: AccountInput, passwordEncrypted?: string): Account | null {
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

export function knownUidsForAccount(accountId: string): Set<string> {
  const db = getDb();
  const rows = db.select({ uid: emails.uid }).from(emails).where(eq(emails.accountId, accountId)).all();
  const deleted = db.select({ uid: deletedEmails.uid }).from(deletedEmails).where(eq(deletedEmails.accountId, accountId)).all();
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
  date: string | null;
  externalNumber?: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, unknown>;
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
      date: e.date,
      externalNumber: e.externalNumber ?? null,
      numberSourceAttachmentId: null,
      numberSourcePage: 1,
      bodyText: e.bodyText,
      bodyHtml: e.bodyHtml,
      headers: JSON.stringify(e.headers ?? {}),
      analysisStatus: "pending",
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
