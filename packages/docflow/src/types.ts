// Доменные типы серверной части: пользователи, роли, сессии, аудит.
// Почтовые типы живут в @mailsense/core — здесь только серверные сущности.
// LdapProfile тоже относится к каталогу (core) и отсюда реэкспортируется ниже.
export type { LdapProfile } from "@mailsense/core/directory";

/** Источник учётной записи. */
export type UserSource = "ldap" | "local" | "manual";

/**
 * Идентификаторы встроенных ролей. Роли хранятся в локальной БД (LDAP — источник истины
 * только для кадровых данных), поэтому id фиксированы, а названия редактируемы.
 */
/**
 * Идентификаторы встроенных ролей. `signer` («Подписант») — те, кому ген.дир делегировал право
 * подписи: без отдельной роли пришлось бы выдавать её через «Руководителя», а это шире по смыслу.
 */
export type BuiltinRoleId = "admin" | "secretary" | "manager" | "executor" | "signer";

/** Права проверяются на сервере; UI использует их только для скрытия кнопок. */
export type Permission =
  | "journal.view"
  | "journal.register"
  | "journal.edit"
  | "journal.archive"
  /** Отмена закрытия года (изменение задним числом): только администратор. */
  | "journal.reopen"
  | "resolution.create"
  | "resolution.edit"
  /** Утверждение резолюции: подписант ставит решение (Р8, Р9). */
  | "resolution.approve"
  /** Отправка утверждённой резолюции исполнителям — всегда аппарат (Р9). */
  | "resolution.dispatch"
  | "task.view"
  | "task.report"
  | "users.manage"
  | "settings.manage"
  | "audit.view"
  /**
   * Центр уведомлений: свои уведомления видит каждый вошедший (§6 контракта).
   * Право есть у всех пяти ролей, но не у учётки без ролей: уведомления адресные.
   */
  | "notifications.view";

export interface Role {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  isSystem: boolean;
}

/** Пользователь СЭД (синхронизирован из LDAP или создан вручную). */
export interface User {
  id: string;
  ldapUid: string | null;
  ldapDn: string | null;
  email: string;
  fullName: string;
  department: string;
  position: string;
  managerDn: string | null;
  managerId: string | null;
  phone: string;
  source: UserSource;
  /** Учётка есть в каталоге и не отключена там. */
  isActive: boolean;
  /** Заблокирована администратором вручную (синхронизация с AD это не снимает). */
  blocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Пользователь вместе с назначенными ролями — то, что отдаётся в UI админки. */
export interface UserWithRoles extends User {
  roles: string[];
}

/** Текущий пользователь сессии: то, что видит клиент после входа. */
export interface AuthUser extends UserWithRoles {
  permissions: Permission[];
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

export interface AuditFilter {
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export interface AuditInput {
  userId?: string | null;
  userName?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Состояние входа — отдаётся клиенту до аутентификации, чтобы он знал, что рисовать. */
export interface AuthStatus {
  /** СЭД включён настройкой docflow.enabled. */
  docflowEnabled: boolean;
  /** Каталог настроен и доступен для bind. */
  ldapConfigured: boolean;
  /** Справочник пользователей ещё пуст (ни одной синхронизации). */
  needsBootstrap: boolean;
  /** Задан ли список логинов-администраторов (MAILSENSE_ADMIN_LOGINS). */
  adminConfigured: boolean;
  /** Есть ли в системе действующий администратор. */
  hasAdmin: boolean;
  /** Включён ли аварийный локальный вход (edms.localLogin). */
  localLoginEnabled: boolean;
}

// ---------------- Журнал регистрации входящих (СЭД, этап 2) ----------------

/** Статусы документа — колонки канбана руководителя (ТЗ п. 5). */
export type DocumentStatus = "new" | "on_resolution" | "in_progress" | "executed" | "archived";

export const DOCUMENT_STATUSES: DocumentStatus[] = ["new", "on_resolution", "in_progress", "executed", "archived"];

export const DOCUMENT_STATUS_TITLES: Record<DocumentStatus, string> = {
  new: "Новый",
  on_resolution: "На резолюции",
  in_progress: "На исполнении",
  executed: "Исполнен",
  archived: "В архиве"
};

/** Роль письма в деле: входящее, резолюция, отчёт об исполнении. */
export type DocumentEmailRole = "source" | "resolution" | "report" | "other";

/**
 * Запись журнала. Поля повторяют графы бумажного журнала:
 * 1 — regNumber, 2 — regDate, 3 — docNumber/docDate, 4 — sender, 5 — summary,
 * 6 — sheetsCount, 9 — срок и отметка об исполнении (этап 3), 10 — caseNumber.
 */
export interface DocumentRecord {
  id: string;
  regNumber: string;
  regNumberNumeric: number;
  /** Период нумерации (год). */
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

/** Запись журнала вместе с ФИО зарегистрировавшего — для таблицы. */
export interface DocumentListItem extends DocumentRecord {
  createdByName: string;
  /** Сколько писем привязано к делу. */
  emailsCount: number;
}

export interface DocumentInput {
  docNumber?: string;
  docDate?: string | null;
  sender?: string;
  summary?: string;
  sheetsCount?: number | null;
  caseNumber?: string | null;
  documentName?: string;
  correspondentId?: string | null;
  /** Письмо-источник: регистрация из ящика. */
  emailId?: string | null;
}

export interface DocumentPatch extends DocumentInput {
  status?: DocumentStatus;
  /** Дата регистрации (правится только администратором журнала). */
  regDate?: string;
}

export type DocumentSortField = "regNumber" | "regDate" | "docDate" | "sender" | "summary" | "status" | "createdAt";

export interface DocumentFilter {
  /** Поиск по номеру, отправителю, содержанию, номеру документа. */
  search?: string;
  status?: DocumentStatus;
  period?: string;
  /** Диапазон дат регистрации, включительно. */
  dateFrom?: string;
  dateTo?: string;
  caseNumber?: string;
  correspondentId?: string;
  sort?: DocumentSortField;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface DocumentPage {
  items: DocumentListItem[];
  total: number;
}

export interface DocumentEmailLink {
  documentId: string;
  emailId: string;
  role: DocumentEmailRole;
  linkedAt: string;
  linkedBy: string | null;
}

/** Правило нумерации в том виде, в каком оно лежит в БД. */
export interface NumberingRuleRecord {
  stream: string;
  prefix: string;
  reset: "year" | "never";
  template: string | null;
}

/** Период, открытый для регистрации, и закрытые (выгруженные) годы. */
export interface NumberingState {
  rules: NumberingRuleRecord[];
  /** Год, в котором уже есть документы; null — журнал пуст. */
  openPeriod: string | null;
  archivedPeriods: string[];
  /**
   * Годы, закрытие которых ещё можно отменить: в новом году нет ни одного документа.
   * Подсказка для интерфейса; окончательно решает транзакция переоткрытия.
   */
  reopenablePeriods: string[];
  /** Что мешает зарегистрировать документ прямо сейчас (если мешает). */
  blockedReason: string | null;
}

export interface CaseNomenclatureRecord {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CorrespondentRecord {
  id: string;
  name: string;
  shortName: string;
  inn: string;
  isActive: boolean;
}

/** Найденный дубль при регистрации: письмо уже зарегистрировано или похожий документ. */
export interface DuplicateMatch {
  document: DocumentListItem;
  /** Чем именно совпало: email | docNumber | summary. */
  reason: "email" | "docNumber" | "summary";
}

// ---------------- Резолюции и задачи (СЭД, этап 3) ----------------

/**
 * Состояния резолюции. Путь: черновик → на утверждении → утверждено → отправлено → исполнено.
 * `email_approval` — отдельное состояние для способа В: подписант ответил письмом,
 * но аппарат ещё не подтвердил разбор (Р9). Из него можно уйти и в `approved`, и обратно в `draft`.
 */
export type ResolutionStatus =
  | "draft"
  | "pending_approval"
  | "email_approval"
  | "approved"
  | "sent"
  | "done"
  | "cancelled";

export const RESOLUTION_STATUS_TITLES: Record<ResolutionStatus, string> = {
  draft: "Черновик",
  pending_approval: "На утверждении",
  email_approval: "Ответ подписанта — ждёт подтверждения",
  approved: "Утверждено, ждёт отправки",
  sent: "Отправлено исполнителям",
  done: "Исполнено",
  cancelled: "Отменено"
};

/** Приоритет — как в макете: СРОЧНО / ВАЖНО / ОБЫЧНО. */
export type ResolutionPriority = "urgent" | "important" | "normal";

export const PRIORITY_TITLES: Record<ResolutionPriority, string> = {
  urgent: "СРОЧНО",
  important: "ВАЖНО",
  normal: "ОБЫЧНО"
};

/** Роль исполнителя в резолюции (Р10). */
export type AssigneeKind = "responsible" | "coexecutor";

/**
 * Шаг утверждения — вся история движения резолюции.
 *
 * `dispatch_failed` — отправка не удалась, поручение возвращено в «утверждено»
 * (письмо ушло не всем либо не ушло вовсе). Отличается от `rejected`: там решение
 * не принято, здесь решение в силе, но диспетчеризация сорвалась.
 */
export type ApprovalStep =
  | "requested"
  | "approved"
  | "rejected"
  | "confirmed"
  | "dispatched"
  | "cancelled"
  | "dispatch_failed";

/** Способ утверждения резолюции (Р9): только два — иначе подпись неотличима от правки. */
export type ApprovalMethod = "app" | "email";

/**
 * Как был сделан отдельный шаг истории. Здесь шире: черновик создаётся вручную,
 * отправка может быть и без письма (например, задача выдана лично).
 */
export type HistoryMethod = ApprovalMethod | "manual";

export interface ResolutionAssignee {
  userId: string;
  /** ФИО на момент чтения — чтобы не делать второй запрос ради списка. */
  fullName: string;
  email: string;
  kind: AssigneeKind;
  /** Графа 8 журнала, «расписка»: исполнитель подтвердил получение. */
  receivedAt: string | null;
  reportText: string | null;
  reportAt: string | null;
}

export interface ResolutionRecord {
  id: string;
  documentId: string;
  /** Текст, который уходит исполнителям. */
  text: string;
  /** Исходный текст до правок — база для будущей подсказки резолюции. */
  sourceText: string;
  /** `forwarded` — письмо переслано руководителю, резолюцию он пишет сам. */
  sourceKind: "manual" | "ai" | "email" | "forwarded";
  status: ResolutionStatus;
  priority: ResolutionPriority;
  deadline: string | null;
  preparedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalMethod: ApprovalMethod | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  requestEmailId: string | null;
  approvalEmailId: string | null;
  dispatchEmailId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Резолюция со всем, что нужно экранам: исполнители, история, номер документа. */
export interface ResolutionDetail extends ResolutionRecord {
  assignees: ResolutionAssignee[];
  history: ResolutionApprovalEntry[];
  /**
   * Сколько дней осталось до срока (отрицательное — просрочено) — приложение А11.
   * Канбан считает подсветку по серверному значению, а не по своему порогу: иначе
   * картинка на карточке и напоминание разойдутся на границе порога.
   */
  daysLeft: number | null;
  /** Срок наступает в пределах notifications.dueSoonDays (А11). */
  dueSoon: boolean;
  /** Номер документа журнала — для навигации и писем. */
  documentNumber: string;
  documentSummary: string;
  /** Письмо, из которого вырос документ: начало всей переписки по делу. */
  documentEmailId: string | null;
  /** ФИО участников — их видно в интерфейсе без второй выборки. */
  preparedByName: string;
  approvedByName: string;
  dispatchedByName: string;
  confirmedByName: string;
}

export interface ResolutionApprovalEntry {
  id: string;
  step: ApprovalStep;
  actorId: string | null;
  actorName: string;
  method: HistoryMethod | null;
  comment: string | null;
  emailId: string | null;
  createdAt: string;
}

/** Задача исполнителя: то, что видно в «Мои задачи». */
export interface TaskItem {
  resolutionId: string;
  kind: AssigneeKind;
  text: string;
  priority: ResolutionPriority;
  deadline: string | null;
  receivedAt: string | null;
  reportAt: string | null;
  /** Что именно написал исполнитель в отчёте. */
  reportText: string | null;
  documentId: string;
  documentNumber: string;
  documentSummary: string;
  /** Письмо-источник: из задачи должно быть видно, о чём вообще речь. */
  emailId: string | null;
  /** Просрочена ли задача на момент чтения. */
  overdue: boolean;
  /** Срок наступает в пределах notifications.dueSoonDays (А5) — для подсветки. */
  dueSoon: boolean;
  /** Сколько дней осталось (отрицательное — просрочено). */
  daysLeft: number | null;
}

export interface ResolutionFilter {
  status?: ResolutionStatus;
  documentId?: string;
  /** Только резолюции, где этот человек — исполнитель. */
  assigneeId?: string;
  limit?: number;
  offset?: number;
}

export interface ResolutionPage {
  items: ResolutionDetail[];
  total: number;
}

/** Колонки канбана руководителя (ТЗ п. 5). */
export interface BoardColumn {
  key: string;
  title: string;
  items: ResolutionDetail[];
}


// ---------------- Уведомления и автосортировка (СЭД, этап 5) ----------------

/** Уровень уведомления: цвет иконки в центре уведомлений. */
export type NotificationSeverity = "info" | "warning" | "danger";

/**
 * Раздел интерфейса, куда ведёт уведомление (контракт §7). Сервер отдаёт именно
 * раздел, а не URL: маршруты — дело клиента, и они меняются чаще, чем событие.
 */
export type NotificationLink = "tasks" | "approvals" | "confirmation" | "board" | "journal" | null;

/**
 * Уведомление в том виде, в каком его видит клиент (контракт §6).
 *
 * `deadline` и `daysLeft` не хранятся в таблице: они считаются на чтении из резолюции,
 * иначе после продления срока в уведомлении осталась бы старая дата.
 */
export interface AppNotification {
  id: string;
  kind: string;
  entityType: "resolution" | "document";
  entityId: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  createdAt: string;
  readAt: string | null;
  deadline: string | null;
  daysLeft: number | null;
  link: NotificationLink;
}

/** Шаблон текста уведомления (key = kind). */
export interface NotificationTemplate {
  key: string;
  title: string;
  body: string;
  isActive: boolean;
  updatedAt: string;
}

/** Переменная шаблона уведомления: имя для текста и человеческая подпись (А2). */
export interface NotificationVariable {
  key: string;
  title: string;
}

/** Настройки уведомлений для админской вкладки (§4 и приложение А). */
export interface NotificationSettingsView {
  enabled: boolean;
  dueSoonDays: number;
  workdayDeadlines: boolean;
  /** Нерабочие дни (праздники) для расчёта типового срока в рабочих днях (А3). */
  holidays: string[];
  /** Что можно подставить в шаблон — список заморожен (А2). */
  variables: NotificationVariable[];
  templates: NotificationTemplate[];
}

export interface NotificationPage {
  items: AppNotification[];
  unread: number;
  total: number;
  /** Включены ли уведомления целиком: клиент гасит бейдж, не дёргая настройки (А4). */
  enabled: boolean;
}

/**
 * Правило автосортировки в том виде, в каком оно лежит в БД.
 *
 * Имена полей совпадают с `MailSortRule` из @mailsense/core (§5) — матчинг делает
 * core, и второй реализации быть не должно; здесь только хранение.
 */
export interface MailSortRuleRecord {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  matchFrom: string;
  matchTo: string;
  matchSubject: string;
  label: string;
  /** 1..5, больше — важнее; null — не подсказывать. */
  priority: number | null;
  note: string;
}

/**
 * Права на этапе 5 добавляются аддитивно: `notifications.view` — всем ролям,
 * настройки и правила остаются за `settings.manage` (только администратор).
 */
export interface LoginInput {
  login: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}
