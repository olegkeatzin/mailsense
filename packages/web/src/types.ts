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

export interface ComposeTemplateAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
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

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data: string;
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
