// Доменные типы MailSense
export type Protocol = "imap" | "pop3";
export type TlsMode = "none" | "ssl" | "starttls";
export type AuthType = "login" | "plain" | "oauth2";
export type Category = "work" | "personal" | "spam";
export type AnalysisStatus =
  | "pending"
  | "queued"
  | "processing"
  | "ready"
  | "error";

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AccountSettings {
  rejectUnauthorized?: boolean;
  pollIntervalSeconds?: number;
  folders?: string[];
  /** Имя отправителя в заголовке From. */
  displayName?: string;
  /** Текст подписи (plain, фолбэк для text/plain). */
  signature?: string;
  /** Подпись с форматированием (HTML из WYSIWYG-редактора). */
  signatureHtml?: string | null;
  signatureEnabled?: boolean;
  /** Положение подписи относительно цитаты. */
  signaturePosition?: "above" | "below";
  /** Добавлять стандартный разделитель подписи "-- ". */
  signatureDelimiter?: boolean;
  /** Цитировать оригинал в ответе. */
  replyQuote?: boolean;
  /** Язык строки атрибуции («… пишет:» / «On … wrote:»). */
  replyAttribution?: "ru" | "en";
  /** Прикреплять вложения оригинала при пересылке. */
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
  passwordEncrypted: string;
  authType: AuthType;
  settings: AccountSettings;
  /** SMTP (отправка); null = не настроен */
  smtpHost: string | null;
  smtpPort: number | null;
  smtpTls: TlsMode | null;
  smtpUsername: string | null;
  smtpPasswordEncrypted: string | null;
  smtpAuthType: AuthType | null;
  createdAt: string;
  updatedAt: string;
}

/** Поля, которые задаёт пользователь (пароль передаётся открытым — шифруется на сервере). */
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
  analysisStatus: AnalysisStatus;
  createdAt: string;
  updatedAt: string;
}

export type AttachmentKind =
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "text"
  | "html"
  | "other";

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
  priority: number; // 1..5
  urgent: boolean;
  eventDate: string | null;
  category: Category;
  rawResponse: string;
  attachments: { name: string; description: string }[];
  modelUsed: string;
  createdAt: string;
  updatedAt: string;
}

/** DTO для UI: письмо + вложения + результат анализа. */
export interface EmailView extends Email {
  attachments: Attachment[];
  analysis: AnalysisResult | null;
}

export interface Settings {
  key: string;
  value: string;
}

export type Folder = "INBOX" | "PROCESSED" | "SPAM";

// ---------------- Отправка / черновики / треды ----------------

export interface Thread {
  id: string;
  accountId: string;
  normalizedSubject: string;
  rootMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data: string; // base64
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

/** Настройки подключения к LDAP/AD (каталог для адресной книги). */
export interface LdapSettings {
  enabled?: boolean;
  /** ldaps://dc.asup.local:636 или ldap://192.168.1.40:389 */
  url?: string;
  baseDn?: string;
  /** Как из логина собрать bind-строку: UPN / sAMAccountName / DOMAIN\\user / готовый DN. */
  loginFormat?: "upn" | "sam" | "domain" | "dn";
  upnSuffix?: string;
  netbiosDomain?: string;
  /** Базовый фильтр отбора пользователей (по умолчанию — person/user с почтой и не отключённые). */
  userFilter?: string;
  attributes?: string[];
  sizeLimit?: number;
  rejectUnauthorized?: boolean;
}

/** Контакт каталога (для автокомплита адресов). */
export interface DirectoryContact {
  dn: string;
  login: string;
  displayName: string;
  mail: string;
  title: string;
  department: string;
  phone: string;
  updatedAt?: string;
}

/** Шаблон письма (заготовка темы/тела). accountId=null — общий для всех аккаунтов. */
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

/** Вложение, приходящее из UI (base64). */
export interface ComposeAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
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
