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

/**
 * Письмо-источник поручения (T41): урезанный вид письма для исполнителя,
 * у которого нет права mail.view. Ни ящика, ни папок, ни путей к файлам сервер не отдаёт.
 */
/** Ящик, с которого работник может отправлять письма СЭД (T53). */
export interface EdmsMailOption {
  id: string;
  username: string;
  host: string;
  /** Готов ли ящик к отправке: без SMTP письмо не уйдёт. */
  smtpReady: boolean;
  /** Служебный ящик подставляет администратор, личный — свой рабочий. */
  kind: "service" | "personal";
}

/** Запись выбранного ящика: сервер отдаёт её без признака kind (он есть только в списке allowed). */
export interface EdmsMailAccountRef {
  id: string;
  username: string;
  host: string;
  smtpReady: boolean;
}

/**
 * Умолчания почтового сервера предприятия (пункт 5): адрес, порты, шифрование и способ входа.
 * Их задаёт предприятие, работник вводит только адрес ящика и пароль.
 */
export interface MailServerDefaults {
  host?: string;
  port?: number;
  tls?: string;
  authType?: string;
}

export interface MailDefaults {
  imap?: MailServerDefaults;
  pop3?: MailServerDefaults;
  smtp?: MailServerDefaults;
}

/** Выдача ящиков работнику администратором (T57). */
export interface EdmsMailAllowance {
  userId: string;
  /**
   * Выданные АДРЕСА ящиков (без дублей); пустой массив — ничего не выдано.
   * Администратор назначает адрес (обычно из каталога), пароль вводит сам работник.
   */
  addresses: string[];
  /** Идентификаторы ящиков работника, попавших в выдачу: оставлено для прежних экранов. */
  accountIds: string[];
  allowed: EdmsMailOption[];
  /**
   * Ящик, который был выбран работником и только что отозван: его выбор сброшен.
   * Показываем администратору, иначе непонятно, почему у работника пропала настройка.
   */
  resetChoice: string | null;
}

/** Личный выбор ящика для СЭД: что выбрано, что можно выбрать и что предложено по умолчанию. */
export interface EdmsMailSettings {
  accountId: string | null;
  account: EdmsMailAccountRef | null;
  allowed: EdmsMailOption[];
  defaultAccountId: string | null;
}

export interface TaskSourceEmail {
  resolutionId: string;
  emailId: string;
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

/**
 * Личные настройки почты работника (локальный профиль, только свои данные).
 *
 * Имя подписи (displayName) уходит в письмо как fromName: адрес остаётся адресом ящика,
 * а человек подписывается своим именем. Подпись ЯЩИКА при этом не подставляется —
 * шаблон запрашивается с useAccountSignature=false, тело дополняет клиент.
 */
export interface MailProfile {
  /** Ключ профиля — логин работника (сервер знает его сам). */
  userId: string;
  displayName: string;
  signatureText: string;
  /** false — подпись выключена (это НЕ «профиль не заполнен»). */
  signatureEnabled: boolean;
  /** above — до цитаты, below — после неё. */
  signaturePosition: "above" | "below";
  /** Включать ли цитату в ответ. */
  replyQuote: boolean;
  /** Язык строки атрибуции перед цитатой. */
  replyAttribution: "ru" | "en";
  updatedAt: string | null;
}

/** Частичная правка профиля: отправляем только изменённые поля (userId/updatedAt не правим). */
export type MailProfilePatch = Partial<
  Pick<MailProfile, "displayName" | "signatureText" | "signatureEnabled" | "signaturePosition" | "replyQuote" | "replyAttribution">
>;

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
  /**
   * Отображаемое имя отправителя (Т36): берётся из личного профиля работника.
   * Это ТОЛЬКО имя — адрес всегда адрес ящика accountId, подменить его телом нельзя.
   */
  fromName?: string;
  /**
   * Адрес для ответа (Р19): у ответа — адрес ящика, куда пришло письмо.
   * Ядро проверяет формат и отклоняет некорректный.
   */
  replyTo?: string;
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
  /** Центр уведомлений (этап 5). Есть у всех пяти ролей — иначе у части сотрудников его не будет. */
  | "notifications.view"
  | "users.manage"
  | "settings.manage"
  | "audit.view"
  /**
   * ⚠️ Прав на почту в списке НЕТ намеренно: свой ящик и своя почта — собственные данные
   * работника, доступ решает ВЛАДЕЛЕЦ ящика (docs/design/mail-ownership.md). Официальные
   * письма уходят по правам СЭД и выданному администратором адресу.
   */

/** Право из каталога: что вообще можно разрешить роли (галочки конструктора). */
export interface PermissionInfo {
  id: Permission;
  title: string;
  group: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  isSystem: boolean;
  /** Права роли. Пустой список — роль ничего не разрешает. */
  permissions: Permission[];
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
  /**
   * Метки правил сортировки (этап 5, §6 контракта).
   * Поля необязательные: сервер отдаёт их только после того, как подключён
   * matchSortRules из core. До этого список честно работает без меток.
   */
  sortLabels?: string[];
  /** Приоритет от правил: больше — важнее; null — правила не подсказали. */
  sortPriority?: number | null;
  /** Подсказки аппарату от сработавших правил. */
  sortNotes?: string[];
  /** Совпало ли письмо хотя бы с одним активным правилом. */
  sortMatched?: boolean;
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
  // Полей про объём/предел архива здесь больше нет: предел 4 ГБ снят (Zip64),
  // а предупреждение о несуществующем пределе было бы враньём. Объявленный, но не
  // работающий контракт хуже отсутствующего: следующий читатель решил бы, что он есть.
}

export interface CaseRecord {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  sortOrder: number;
}

// ---------------- Этап 5: уведомления и правила сортировки ----------------
// Имена полей — ровно из §6 контракта (согласованы с server-backend 2026-10-07).

export type NotificationSeverity = "info" | "warning" | "danger";

/** Раздел интерфейса, в который ведёт уведомление (§7 контракта). */
export type NotificationLink = "tasks" | "approvals" | "confirmation" | "board" | "journal";

/** Уведомление центра уведомлений (§6 контракта). */
export interface AppNotification {
  id: string;
  /** Вид из §3: resolution.assigned, resolution.due_soon, resolution.overdue и т.д. */
  kind: string;
  entityType: "resolution" | "document";
  entityId: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  createdAt: string;
  readAt: string | null;
  /** Срок задачи, к которому относится напоминание (для `due_*`/`overdue`). */
  deadline: string | null;
  daysLeft: number | null;
  link: NotificationLink | null;
}

export interface NotificationTemplate {
  key: string;
  title: string;
  body: string;
  isActive: boolean;
  updatedAt: string;
}

export interface NotificationSettings {
  enabled: boolean;
  /** За сколько дней предупреждать о сроке: 0..30. */
  dueSoonDays: number;
  /** Считать типовой срок в рабочих днях. */
  workdayDeadlines: boolean;
  templates: NotificationTemplate[];
  /**
   * Доступные подстановки шаблона с русскими подписями — приходят с сервера (А2).
   * Свой список в интерфейсе не хардкодим: он разъедется с тем, что подставляет сервер.
   */
  variables: Array<{ key: string; title: string }>;
  /** Праздничные дни YYYY-MM-DD (А3): в рабочие дни не считаются. */
  holidays: string[];
}

/** Тело PUT /notifications/settings: меняем только то, что реально правили. */
export interface NotificationSettingsPatch {
  enabled?: boolean;
  dueSoonDays?: number;
  workdayDeadlines?: boolean;
  holidays?: string[];
  templates?: Array<Pick<NotificationTemplate, "key" | "title" | "body" | "isActive">>;
}

export interface NotificationsPage {
  items: AppNotification[];
  unread: number;
  total: number;
  /** Уведомления включены администратором (А4). Иначе честный текст, а не пустой список. */
  enabled: boolean;
}

/** Правило автосортировки почты (§5 контракта — маршрутизация и подсветка, не авторегистрация). */
export interface MailSortRule {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  matchFrom: string;
  matchTo: string;
  matchSubject: string;
  label: string;
  /** 1..5, больше — важнее; null — приоритет не подсказывать. */
  priority: number | null;
  note: string;
}

/** Тело POST/PATCH правила и предпросмотра (camelCase, без id). */
export type MailSortRuleInput = Partial<Omit<MailSortRule, "id">>;

export interface SortPreviewSample {
  emailId: string;
  subject: string;
  from: string;
  labels: string[];
  notes: string[];
  priority: number | null;
}

export interface SortPreview {
  /** Сколько писем поймало правило. */
  matched: number;
  /** Сколько писем вообще проверено. */
  total: number;
  samples: SortPreviewSample[];
}

// ---------------- Р12: служебный ящик отправки ----------------

/** Параметры служебного ящика. Пароли сервер не отдаёт вообще — их здесь нет и быть не должно. */
export interface ServiceAccount {
  accountId: string;
  /** Человекочитаемая подпись и логин ящика. */
  name: string;
  username: string;
  protocol: Protocol;
  host: string;
  port: number;
  tls: TlsMode | string;
  authType: string;
  smtpHost: string;
  smtpPort: number | null;
  smtpTls: string | null;
  smtpUsername: string;
  /** Заполнен ли адрес SMTP. */
  smtpHostConfigured: boolean;
  /** Отправка РЕАЛЬНО возможна: адрес И пароль (свой SMTP либо пароль ящика) — как в sendService. */
  smtpConfigured: boolean;
}

/**
 * Машинный код проблемы. Нужен, чтобы выбрать действие в интерфейсе, не разбирая
 * русский текст (правило проекта: тексты не парсить). Сервер может его не отдавать —
 * тогда интерфейс показывает problem как есть и не гадает.
 */
export type ServiceAccountProblemCode =
  /** Проблемы нет. */
  | "ok"
  /** Служебный ящик не выбран. */
  | "not_configured"
  /** Выбранный ящик больше не существует. */
  | "account_missing"
  /** У ящика не настроена отправка. */
  | "smtp_not_configured"
  /** Только при попытке отправки. */
  | "unknown_account"
  | "no_account";

/** Одна служебная роль: выбранный ящик и проблема, если она есть. */
export interface ServiceAccountBlock {
  configured: boolean;
  account: ServiceAccount | null;
  /** Готовый текст для человека; разметки не содержит. */
  problem: string | null;
  /** Машинный код: "ok" — проблем нет. */
  problemCode: ServiceAccountProblemCode;
}

export interface ServiceAccountState extends ServiceAccountBlock {
  /**
   * Внешняя приёмная: куда приходит внешняя почта. Необязательно — старая сборка сервера
   * это поле не отдаёт, и тогда интерфейс честно показывает только внутреннюю роль.
   */
  incoming?: ServiceAccountBlock;
  /** Обе роли на одном ящике (пилот): не запрет, но предупредить надо. */
  sameAccount?: boolean;
  /** Готовый русский текст предупреждения от сервера; null — предупреждать не о чем. */
  notice?: string | null;
}

/** Тело PUT: обе роли можно изменить одним вызовом; null — снять выбор. */
export interface ServiceAccountPatch {
  accountId?: string | null;
  incomingAccountId?: string | null;
}
