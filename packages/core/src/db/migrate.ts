import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  tls TEXT NOT NULL,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'login',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  uid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  "from" TEXT NOT NULL DEFAULT 'null',
  "to" TEXT NOT NULL DEFAULT '[]',
  date TEXT,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS emails_message_id_idx ON emails(message_id);
CREATE INDEX IF NOT EXISTS emails_account_folder_idx ON emails(account_id, folder);
CREATE INDEX IF NOT EXISTS emails_status_idx ON emails(analysis_status);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT,
  extracted_text TEXT,
  content_id TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_email_idx ON attachments(email_id);

CREATE TABLE IF NOT EXISTS analysis_results (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 3,
  urgent INTEGER NOT NULL DEFAULT 0,
  event_date TEXT,
  category TEXT NOT NULL DEFAULT 'personal',
  raw_response TEXT NOT NULL DEFAULT '',
  model_used TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS analysis_email_idx ON analysis_results(email_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    version: 2,
    name: "attachment_ai_description",
    sql: `
ALTER TABLE attachments ADD COLUMN ai_description TEXT;
ALTER TABLE analysis_results ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
`
  },
  {
    version: 3,
    name: "deleted_emails_tombstones",
    sql: `
CREATE TABLE IF NOT EXISTS deleted_emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS deleted_emails_account_uid_idx ON deleted_emails(account_id, uid);
CREATE INDEX IF NOT EXISTS deleted_emails_message_id_idx ON deleted_emails(message_id);
`
  },
  {
    version: 4,
    name: "email_external_number",
    sql: `
ALTER TABLE emails ADD COLUMN external_number TEXT;
`
  },
  {
    version: 5,
    name: "email_number_source",
    sql: `
ALTER TABLE emails ADD COLUMN number_source_attachment_id TEXT;
ALTER TABLE emails ADD COLUMN number_source_page INTEGER NOT NULL DEFAULT 1;
`
  },
  {
    version: 6,
    name: "email_send_date",
    sql: `
ALTER TABLE emails ADD COLUMN send_date TEXT;
`
  },
  {
    version: 7,
    name: "smtp_threads_drafts",
    sql: `
ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
ALTER TABLE accounts ADD COLUMN smtp_tls TEXT;
ALTER TABLE accounts ADD COLUMN smtp_username TEXT;
ALTER TABLE accounts ADD COLUMN smtp_password_encrypted TEXT;
ALTER TABLE accounts ADD COLUMN smtp_auth_type TEXT DEFAULT 'login';

ALTER TABLE emails ADD COLUMN thread_id TEXT;
ALTER TABLE emails ADD COLUMN cc TEXT NOT NULL DEFAULT '[]';
ALTER TABLE emails ADD COLUMN reply_to TEXT NOT NULL DEFAULT '[]';
ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE emails ADD COLUMN refs TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS emails_thread_idx ON emails(thread_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  normalized_subject TEXT NOT NULL DEFAULT '',
  root_message_id TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_account_idx ON threads(account_id);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  "to" TEXT NOT NULL DEFAULT '[]',
  cc TEXT NOT NULL DEFAULT '[]',
  bcc TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  in_reply_to_email_id TEXT,
  in_reply_to_message_id TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_account_idx ON drafts(account_id);
`
  },
  {
    version: 8,
    name: "deleted_emails_folder",
    sql: `
DROP INDEX IF EXISTS deleted_emails_account_uid_idx;
CREATE TABLE deleted_emails_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  uid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
INSERT INTO deleted_emails_new (id, account_id, folder, uid, message_id, deleted_at)
  SELECT id, account_id, 'INBOX', uid, message_id, deleted_at FROM deleted_emails;
DROP TABLE deleted_emails;
ALTER TABLE deleted_emails_new RENAME TO deleted_emails;
CREATE UNIQUE INDEX IF NOT EXISTS deleted_emails_account_folder_uid_idx ON deleted_emails(account_id, folder, uid);
CREATE INDEX IF NOT EXISTS deleted_emails_message_id_idx ON deleted_emails(message_id);
`
  }
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set<number>(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version)
  );
  const pending = migrations.filter((m) => !applied.has(m.version));
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString()
      );
    });
    run();
  }
}
