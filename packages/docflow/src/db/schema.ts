import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Схема серверной части (документооборот) на PostgreSQL.
 *
 * Локальное приложение MailSense работает на SQLite — это его собственная база.
 * Документооборот живёт на сервере в PostgreSQL: у серверной части отдельный
 * жизненный цикл, резервное копирование и требования к параллельному доступу.
 *
 * Таблиц почты здесь нет: связь с письмами — по строковому email_id, без внешнего
 * ключа (письма лежат в базе клиента, документы — на сервере).
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** sAMAccountName из LDAP; NULL у локальных/внешних учёток. */
    ldapUid: text("ldap_uid"),
    /**
     * Ключ поиска: ldapUid в нижнем регистре, посчитанный средствами JS.
     * Поведение lower() зависит от локали СУБД, а логины AD кириллические —
     * нормализуем один раз при записи и ищем по этому ключу.
     */
    ldapUidKey: text("ldap_uid_key"),
    ldapDn: text("ldap_dn"),
    email: text("email").notNull().default(""),
    fullName: text("full_name").notNull().default(""),
    department: text("department").notNull().default(""),
    position: text("position").notNull().default(""),
    managerDn: text("manager_dn"),
    managerId: text("manager_id"),
    phone: text("phone").notNull().default(""),
    /** ldap — синхронизирован из каталога, local — аварийный вход, manual — внешний контрагент. */
    source: text("source").notNull().default("ldap"),
    /** scrypt-хэш; только для source = local. */
    passwordHash: text("password_hash"),
    /** Следует за каталогом: отсутствует/отключён в AD → false. */
    isActive: boolean("is_active").notNull().default(true),
    /** Ручная блокировка администратором: синхронизация с AD её не снимает. */
    blocked: boolean("blocked").notNull().default(false),
    lastLoginAt: text("last_login_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    // NULL в PostgreSQL уникальны по умолчанию — локальные учётки не конфликтуют.
    uidIdx: uniqueIndex("users_ldap_uid_key_idx").on(t.ldapUidKey),
    emailIdx: index("users_email_idx").on(t.email),
    activeIdx: index("users_active_idx").on(t.isActive)
  })
);

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  isSystem: boolean("is_system").notNull().default(true)
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedAt: text("granted_at").notNull(),
    grantedBy: text("granted_by")
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roleId] }),
    roleIdx: index("user_roles_role_idx").on(t.roleId)
  })
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 от токена сессии — сам токен в БД не хранится. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    userAgent: text("user_agent").notNull().default(""),
    ip: text("ip").notNull().default("")
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expIdx: index("sessions_expires_idx").on(t.expiresAt)
  })
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    /** Дублируем имя: пользователь может быть удалён, а история должна читаться. */
    userName: text("user_name").notNull().default(""),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: text("created_at").notNull()
  },
  (t) => ({
    createdIdx: index("audit_created_idx").on(t.createdAt),
    entityIdx: index("audit_entity_idx").on(t.entityType, t.entityId),
    userIdx: index("audit_user_idx").on(t.userId)
  })
);

/** Собственные настройки серверной части — в своей базе, а не в настройках почты. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

/** Журнал входящих документов — графы бумажного журнала. */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    regNumber: text("reg_number").notNull(),
    /** Числовая часть номера: «вх2» должно идти раньше «вх10». */
    regNumberNumeric: integer("reg_number_numeric").notNull().default(0),
    regPeriod: text("reg_period").notNull(),
    regDate: text("reg_date").notNull(),
    docNumber: text("doc_number").notNull().default(""),
    docDate: text("doc_date"),
    sender: text("sender").notNull().default(""),
    summary: text("summary").notNull().default(""),
    sheetsCount: integer("sheets_count"),
    caseNumber: text("case_number"),
    documentName: text("document_name").notNull().default(""),
    /** new | on_resolution | in_progress | executed | archived */
    status: text("status").notNull().default("new"),
    emailId: text("email_id"),
    correspondentId: text("correspondent_id"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at")
  },
  (t) => ({
    // Номер уникален внутри периода: два «вх5» за один год невозможны.
    periodNumberIdx: uniqueIndex("documents_period_number_idx").on(t.regPeriod, t.regNumber),
    regDateIdx: index("documents_reg_date_idx").on(t.regDate),
    emailIdx: index("documents_email_idx").on(t.emailId),
    statusIdx: index("documents_status_idx").on(t.status),
    caseIdx: index("documents_case_idx").on(t.caseNumber)
  })
);

/** Связь документа с письмами: входящее, резолюция, отчёт. */
export const documentEmails = pgTable(
  "document_emails",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    emailId: text("email_id").notNull(),
    role: text("role").notNull().default("source"),
    linkedAt: text("linked_at").notNull(),
    linkedBy: text("linked_by")
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.emailId] }),
    emailIdx: index("document_emails_email_idx").on(t.emailId)
  })
);

/** Счётчики номеров: атомарный инкремент по (поток, период). */
export const numberCounters = pgTable(
  "number_counters",
  {
    stream: text("stream").notNull(),
    period: text("period").notNull(),
    lastNumber: integer("last_number").notNull().default(0)
  },
  (t) => ({ pk: primaryKey({ columns: [t.stream, t.period] }) })
);

export const numberRules = pgTable("number_rules", {
  stream: text("stream").primaryKey(),
  prefix: text("prefix").notNull(),
  reset: text("reset").notNull().default("year"),
  template: text("template")
});

/** Выгрузка журнала в архив — закрывает период. */
export const numberArchives = pgTable(
  "number_archives",
  {
    id: text("id").primaryKey(),
    stream: text("stream").notNull(),
    period: text("period").notNull(),
    fileName: text("file_name").notNull().default(""),
    documentCount: integer("document_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by")
  },
  (t) => ({ periodIdx: uniqueIndex("number_archives_period_idx").on(t.stream, t.period) })
);

export const caseNomenclature = pgTable(
  "case_nomenclature",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    title: text("title").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({ codeIdx: uniqueIndex("case_nomenclature_code_idx").on(t.code) })
);

export const correspondents = pgTable(
  "correspondents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull().default(""),
    inn: text("inn").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({ nameIdx: index("correspondents_name_idx").on(t.name) })
);

export const deadlinePresets = pgTable("deadline_presets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  days: integer("days").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0)
});

export const resolutionTemplates = pgTable("resolution_templates", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0)
});

/** Резолюции: документ → много резолюций, резолюция → много исполнителей (Р5). */
export const resolutions = pgTable(
  "resolutions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    text: text("text").notNull().default(""),
    /** Исходный текст до правок: база для будущей подсказки резолюции. */
    sourceText: text("source_text").notNull().default(""),
    sourceKind: text("source_kind").notNull().default("manual"),
    /** draft | pending_approval | approved | sent | done | cancelled */
    status: text("status").notNull().default("draft"),
    priority: text("priority").notNull().default("normal"),
    deadline: text("deadline"),
    preparedBy: text("prepared_by"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    approvalMethod: text("approval_method"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: text("confirmed_at"),
    dispatchedBy: text("dispatched_by"),
    dispatchedAt: text("dispatched_at"),
    requestEmailId: text("request_email_id"),
    approvalEmailId: text("approval_email_id"),
    dispatchEmailId: text("dispatch_email_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => ({
    docIdx: index("resolutions_document_idx").on(t.documentId),
    statusIdx: index("resolutions_status_idx").on(t.status),
    deadlineIdx: index("resolutions_deadline_idx").on(t.deadline)
  })
);

/** Исполнители резолюции — графа 8 журнала, включая «расписку». */
export const resolutionAssignees = pgTable(
  "resolution_assignees",
  {
    resolutionId: text("resolution_id")
      .notNull()
      .references(() => resolutions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** responsible | coexecutor (Р10). */
    kind: text("kind").notNull().default("coexecutor"),
    receivedAt: text("received_at"),
    reportText: text("report_text"),
    reportAt: text("report_at"),
    reportEmailId: text("report_email_id"),
    /** Краткая суть, распознанная моделью в письме-ответе: предложение, а не отчёт. */
    reportSummary: text("report_summary"),
    /** Когда предложение появилось. `reportAt` пуст — значит не подтверждено аппаратом. */
    reportProposedAt: text("report_proposed_at"),
    createdAt: text("created_at").notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.resolutionId, t.userId] }),
    userIdx: index("resolution_assignees_user_idx").on(t.userId)
  })
);

/** Шаги утверждения: отправлено, утверждено, подтверждено, отправлено исполнителям. */
export const resolutionApprovals = pgTable(
  "resolution_approvals",
  {
    id: text("id").primaryKey(),
    resolutionId: text("resolution_id")
      .notNull()
      .references(() => resolutions.id, { onDelete: "cascade" }),
    /** requested | approved | rejected | confirmed | dispatched */
    step: text("step").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name").notNull().default(""),
    method: text("method"),
    comment: text("comment"),
    emailId: text("email_id"),
    createdAt: text("created_at").notNull()
  },
  (t) => ({ resIdx: index("resolution_approvals_res_idx").on(t.resolutionId) })
);

export const docflowSchema = {
  users,
  roles,
  userRoles,
  sessions,
  auditLog,
  settings,
  documents,
  documentEmails,
  numberCounters,
  numberRules,
  numberArchives,
  caseNomenclature,
  correspondents,
  deadlinePresets,
  resolutionTemplates,
  resolutions,
  resolutionAssignees,
  resolutionApprovals
};

export type DbUsers = typeof users.$inferSelect;
export type DbRoles = typeof roles.$inferSelect;
export type DbSessions = typeof sessions.$inferSelect;
export type DbAuditLog = typeof auditLog.$inferSelect;
export type DbDocument = typeof documents.$inferSelect;
export type DbDocumentEmail = typeof documentEmails.$inferSelect;
export type DbCaseNomenclature = typeof caseNomenclature.$inferSelect;
export type DbCorrespondent = typeof correspondents.$inferSelect;
export type DbResolution = typeof resolutions.$inferSelect;
export type DbResolutionAssignee = typeof resolutionAssignees.$inferSelect;
export type DbResolutionApproval = typeof resolutionApprovals.$inferSelect;
