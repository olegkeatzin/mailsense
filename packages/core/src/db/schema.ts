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
    statusIdx: index("emails_status_idx").on(t.analysisStatus)
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
    uid: text("uid").notNull(),
    messageId: text("message_id").notNull(),
    deletedAt: text("deleted_at").notNull()
  },
  (t) => ({
    acctUidIdx: uniqueIndex("deleted_emails_account_uid_idx").on(t.accountId, t.uid)
  })
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const schema = { accounts, emails, attachments, analysisResults, deletedEmails, settings };

export type DbEmails = typeof emails.$inferSelect;
export type DbAccounts = typeof accounts.$inferSelect;
export type DbAttachments = typeof attachments.$inferSelect;
export type DbAnalysisResults = typeof analysisResults.$inferSelect;
