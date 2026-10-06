export type Protocol = "imap" | "pop3";
export type TlsMode = "none" | "ssl" | "starttls";
export type AuthType = "login" | "plain" | "oauth2";
export type Category = "work" | "personal" | "spam";
export type AnalysisStatus = "pending" | "queued" | "processing" | "ready" | "error";

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AccountSettings {
  rejectUnauthorized?: boolean;
  pollIntervalSeconds?: number;
  displayName?: string;
  signature?: string;
  /** Подпись с форматированием (HTML из WYSIWYG-редактора). */
  signatureHtml?: string | null;
  signatureEnabled?: boolean;
  signaturePosition?: "above" | "below";
  signatureDelimiter?: boolean;
  replyQuote?: boolean;
  replyAttribution?: "ru" | "en";
  forwardAttachments?: boolean;
  [key: string]: unknown;
}

export interface Account {
  id: string;
  protocol: Protocol;
  host: string;
  port: number;
  tls: TlsMode;
  username: string;
  authType: AuthType;
  settings: AccountSettings;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpTls: TlsMode | null;
  smtpUsername: string | null;
  smtpAuthType: AuthType | null;
}

export interface AccountInput {
  protocol: Protocol;
  host: string;
  port: number;
  tls: TlsMode;
  username: string;
  password?: string;
  authType: AuthType;
  settings?: AccountSettings;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpTls?: TlsMode | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  smtpAuthType?: AuthType | null;
}

export interface Email {
  id: string;
  accountId: string;
  folder: string;
  uid: string;
  messageId: string;
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  date: string | null;
  externalNumber: string | null;
  numberSourceAttachmentId: string | null;
  numberSourcePage: number;
  sendDate: string | null;
  threadId: string | null;
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, unknown>;
  analysis?: AnalysisResult | null;
  analysisStatus: AnalysisStatus;
  createdAt: string;
  updatedAt: string;
}

export type AttachmentKind = "image" | "pdf" | "docx" | "xlsx" | "text" | "html" | "other";

export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string | null;
  extractedText: string | null;
  aiDescription: string | null;
  contentId: string | null;
  kind: AttachmentKind;
  handled: boolean;
  createdAt: string;
}

export interface AnalysisResult {
  id: string;
  emailId: string;
  summary: string;
  tags: string[];
  priority: number;
  urgent: boolean;
  eventDate: string | null;
  category: Category;
  rawResponse: string;
  attachments: { name: string; description: string }[];
  modelUsed: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailView extends Email {
  attachments: Attachment[];
  analysis: AnalysisResult | null;
}

/**
 * Вложение в запросе на отправку: данные (base64) либо ссылка на файл черновика,
 * который сервер прочитает сам (draftId + ref).
 */
export interface ComposeAttachment {
  filename: string;
  mimeType: string;
  data?: string; // base64
  ref?: string;
  draftId?: string;
}

export interface ComposeInput {
  accountId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: ComposeAttachment[];
  inReplyToEmailId?: string | null;
  inReplyToMessageId?: string | null;
  references?: string[];
}

/**
 * Вложение в шаблоне пересылки — ссылка на файл письма, без данных.
 * Файл тянется по требованию: /api/emails/:emailId/attachments/:attachmentId/file
 */
export interface ComposeTemplateAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  emailId: string;
}

export interface ComposeTemplate {
  accountId: string;
  mode: "new" | "reply" | "replyAll" | "forward";
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyToEmailId: string | null;
  inReplyToMessageId: string | null;
  references: string[];
  attachments: ComposeTemplateAttachment[];
}

/**
 * Вложение черновика. Содержимое лежит файлом на сервере (<dataDir>/drafts/<id>/),
 * а в JSON — ссылка на него: автосохранение больше не гоняет base64 каждые 15 секунд.
 */
export interface DraftAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Имя файла в каталоге черновика. */
  ref?: string;
  /** base64 — только у черновика, сохранённого до раскладки вложений в файлы. */
  data?: string;
}

export interface LdapSettings {
  enabled?: boolean;
  url?: string;
  baseDn?: string;
  loginFormat?: "upn" | "sam" | "domain" | "dn";
  upnSuffix?: string;
  netbiosDomain?: string;
  userFilter?: string;
  attributes?: string[];
  sizeLimit?: number;
  rejectUnauthorized?: boolean;
}

export interface DirectoryContact {
  dn: string;
  login: string;
  displayName: string;
  mail: string;
  title: string;
  department: string;
  phone: string;
}

export interface DirectoryStatus {
  loggedIn: boolean;
  login: string | null;
  settings: LdapSettings;
  contacts: number;
}

export interface Template {
  id: string;
  accountId: string | null;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Draft {
  id: string;
  accountId: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface ThreadGroup {
  id: string;
  subject: string;
  count: number;
  lastMessageAt: string | null;
  emails: Email[];
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  multimodal: boolean;
  timeoutMs: number;
  ocrBaseUrl?: string;
  ocrModel?: string;
  concurrency?: number;
  ocrConcurrency?: number;
}


// ---------------- документооборот: пользователи, роли, вход ----------------

export type UserSource = "ldap" | "local" | "manual";

export type Permission =
  | "journal.view"
  | "journal.register"
  | "journal.edit"
  | "journal.archive"
  /** Отмена закрытия года: только администратор. */
  | "journal.reopen"
  | "resolution.create"
  | "resolution.edit"
  | "resolution.approve"
  | "resolution.dispatch"
  | "task.view"
  | "task.report"
  | "users.manage"
  | "settings.manage"
  | "audit.view";

export interface Role {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  isSystem: boolean;
}

export interface User {
  id: string;
  ldapUid: string | null;
  email: string;
  fullName: string;
  department: string;
  position: string;
  managerId: string | null;
  phone: string;
  source: UserSource;
  isActive: boolean;
  blocked: boolean;
  lastLoginAt: string | null;
  roles: string[];
}

export interface AuthUser extends User {
  permissions: Permission[];
}

export interface AuthStatus {
  /** Задан ли список логинов-администраторов (MAILSENSE_ADMIN_LOGINS). */
  adminConfigured: boolean;
  /** Есть ли в системе действующий администратор. */
  hasAdmin: boolean;
  docflowEnabled: boolean;
  ldapConfigured: boolean;
  needsBootstrap: boolean;
  localLoginEnabled: boolean;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

// ---------------- Журнал регистрации (СЭД, этап 2) ----------------

export type DocumentStatus = "new" | "on_resolution" | "in_progress" | "executed" | "archived";

export const DOCUMENT_STATUS_TITLES: Record<DocumentStatus, string> = {
  new: "Новый",
  on_resolution: "На резолюции",
  in_progress: "На исполнении",
  executed: "Исполнен",
  archived: "В архиве"
};

export interface DocumentRecord {
  id: string;
  regNumber: string;
  regNumberNumeric: number;
  regPeriod: string;
  regDate: string;
  docNumber: string;
  docDate: string | null;
  sender: string;
  summary: string;
  sheetsCount: number | null;
  caseNumber: string | null;
  documentName: string;
  status: DocumentStatus;
  emailId: string | null;
  correspondentId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface DocumentListItem extends DocumentRecord {
  /** ФИО того, кто зарегистрировал: видно прямо в журнале. */
  createdByName: string;
  emailsCount: number;
}

export interface DocumentPage {
  items: DocumentListItem[];
  total: number;
}

export interface DocumentCard extends DocumentRecord {
  emails: Array<{ emailId: string; role: string; linkedAt: string }>;
}

export interface JournalFilter {
  search?: string;
  status?: DocumentStatus | "";
  period?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Письмо, ожидающее регистрации (раздел «Входящие на регистрацию»). */
export interface IncomingItem {
  emailId: string;
  accountId: string;
  subject: string;
  from: { name?: string; address: string } | null;
  date: string | null;
  analysisStatus: string;
  externalNumber: string | null;
  sendDate: string | null;
  summary: string;
  priority: number | null;
  tags: string[];
  attachmentsCount: number;
}

/** Подсказки для формы регистрации: то, что удалось взять из письма и ИИ. */
export interface RegisterSuggest {
  emailId: string;
  sender: string;
  summary: string;
  docNumber: string;
  docDate: string;
  sheetsCount: number | null;
  documentName: string;
  alreadyRegistered: string | null;
}

export interface DuplicateMatch {
  document: DocumentListItem;
  reason: "email" | "docNumber" | "summary";
}

export interface NumberingRuleRecord {
  stream: string;
  prefix: string;
  reset: "year" | "never";
  template: string | null;
}

export interface NumberingState {
  rules: NumberingRuleRecord[];
  openPeriod: string | null;
  archivedPeriods: string[];
  /**
   * Годы, закрытие которых ещё можно отменить (в новом году нет документов).
   * Считает сервер; интерфейс лишь показывает — решает всё равно транзакция.
   */
  reopenablePeriods: string[];
  blockedReason: string | null;
  /** Сколько занимают вложения открытого года (null — размер неизвестен: предупреждать нечем). */
  archiveSizeBytes?: number | null;
  /** Предел архива без Zip64 — предупреждение о превышении. */
  archiveLimitBytes?: number;
  /** Готовое предупреждение о объёме архива (текст формирует сервер). */
  archiveWarning?: { level: "ok" | "near" | "over"; text: string | null } | null;
}

export interface CaseRecord {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  sortOrder: number;
}
