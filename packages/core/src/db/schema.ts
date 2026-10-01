import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";
import type { EmailAddress, AnalysisStatus, Category, AttachmentKind } from "../types.js";

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    protocol: text("protocol").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    tls: text("tls").notNull(),
    username: text("username").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    authType: text("auth_type").notNull().default("login"),
    settings: text("settings").notNull().default("{}"),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpTls: text("smtp_tls"),
    smtpUsername: text("smtp_username"),
    smtpPasswordEncrypted: text("smtp_password_encrypted"),
    smtpAuthType: text("smtp_auth_type").default("login"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  }
);

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    folder: text("folder").notNull().default("INBOX"),
    uid: text("uid").notNull(),
    messageId: text("message_id").notNull(),
    subject: text("subject").notNull().default(""),
    from: text("from").notNull().default("null"),
    to: text("to").notNull().default("[]"),
    date: text("date"),
    externalNumber: text("external_number"),
    numberSourceAttachmentId: text("number_source_attachment_id"),
    numberSourcePage: integer("number_source_page").notNull().default(1),
    sendDate: text("send_date"),
    threadId: text("thread_id"),
    cc: text("cc").notNull().default("[]"),
    replyTo: text("reply_to").notNull().default("[]"),
    inReplyTo: text("in_reply_to"),
    references: text("refs").notNull().default("[]"),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    headers: text("headers").notNull().default("{}"),
    analysisStatus: text("analysis_status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    msgIdx: uniqueIndex("emails_message_id_idx").on(t.messageId),
    acctIdx: index("emails_account_folder_idx").on(t.accountId, t.folder),
    statusIdx: index("emails_status_idx").on(t.analysisStatus),
    threadIdx: index("emails_thread_idx").on(t.threadId)
  })
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    storagePath: text("storage_path"),
    extractedText: text("extracted_text"),
    aiDescription: text("ai_description"),
    contentId: text("content_id"),
    kind: text("kind").notNull().default("other"),
    handled: integer("handled", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull()
  },
  (t) => ({
    emailIdx: index("attachments_email_idx").on(t.emailId)
  })
);

export const analysisResults = sqliteTable(
  "analysis_results",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    summary: text("summary").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    priority: integer("priority").notNull().default(3),
    urgent: integer("urgent", { mode: "boolean" }).notNull().default(false),
    eventDate: text("event_date"),
    category: text("category").notNull().default("personal"),
    rawResponse: text("raw_response").notNull().default(""),
    attachments: text("attachments").notNull().default("[]"),
    modelUsed: text("model_used").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    emailIdx: uniqueIndex("analysis_email_idx").on(t.emailId)
  })
);

export const deletedEmails = sqliteTable(
  "deleted_emails",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    folder: text("folder").notNull().default("INBOX"),
    uid: text("uid").notNull(),
    messageId: text("message_id").notNull(),
    deletedAt: text("deleted_at").notNull()
  },
  (t) => ({
    acctUidIdx: uniqueIndex("deleted_emails_account_folder_uid_idx").on(t.accountId, t.folder, t.uid)
  })
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    normalizedSubject: text("normalized_subject").notNull().default(""),
    rootMessageId: text("root_message_id"),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    acctIdx: index("threads_account_idx").on(t.accountId)
  })
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    to: text("to").notNull().default("[]"),
    cc: text("cc").notNull().default("[]"),
    bcc: text("bcc").notNull().default("[]"),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    attachments: text("attachments").notNull().default("[]"),
    inReplyToEmailId: text("in_reply_to_email_id"),
    inReplyToMessageId: text("in_reply_to_message_id"),
    references: text("refs").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    acctIdx: index("drafts_account_idx").on(t.accountId)
  })
);

export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    // null = шаблон доступен для всех аккаунтов
    accountId: text("account_id"),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    acctIdx: index("templates_account_idx").on(t.accountId)
  })
);

export const contacts = sqliteTable(
  "contacts",
  {
    dn: text("dn").primaryKey(),
    login: text("login").notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    mail: text("mail").notNull().default(""),
    title: text("title").notNull().default(""),
    department: text("department").notNull().default(""),
    phone: text("phone").notNull().default(""),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    mailIdx: index("contacts_mail_idx").on(t.mail)
  })
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const schema = { accounts, emails, attachments, analysisResults, deletedEmails, threads, drafts, templates, contacts, settings };

export type DbEmails = typeof emails.$inferSelect;
export type DbAccounts = typeof accounts.$inferSelect;
export type DbAttachments = typeof attachments.$inferSelect;
export type DbAnalysisResults = typeof analysisResults.$inferSelect;
export type DbThreads = typeof threads.$inferSelect;
export type DbDrafts = typeof drafts.$inferSelect;