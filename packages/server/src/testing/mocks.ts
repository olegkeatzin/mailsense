/**
 * Подставные модули для тестов сервера.
 *
 * Подменяем ровно границы, которые мешают юнит-тесту: почтовое ядро (SQLite, IMAP, ИИ)
 * и база документооборота (PostgreSQL). Своя логика — маршруты, middleware прав и
 * обработка потоков — работает по-настоящему.
 *
 * ⚠️ Права ролей берём НАСТОЯЩИЕ из docflow/roles.ts: матрица «маршрут × роль»
 * должна проверять продуктовые права, а не их копию в тесте.
 */
import { permissionsOfRoles } from "@mailsense/docflow/roles";

export interface TestUser {
  id: string;
  fullName: string;
  email: string;
  department: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
  blocked: boolean;
}

/** Пользователь сессии: роли настоящие, права считает docflow. */
export function testUser(id: string, roles: string[], extra: Partial<TestUser> = {}): TestUser {
  return {
    id,
    fullName: "Пользователь " + id,
    email: id + "@stand.test",
    department: "Аппарат",
    roles,
    permissions: permissionsOfRoles(roles),
    isActive: true,
    blocked: false,
    ...extra
  };
}

/**
 * Подставное почтовое ядро. Возвращает Proxy: любой импортированный из ядра символ
 * существует и по умолчанию ничего не делает — тест настраивает нужное сам.
 */
/**
 * Отказ по данным запроса на отправку (fromName/replyTo). Ядро бросает именно этот класс,
 * и маршрут обязан отличить его от сбоя: это 400, а не 500.
 */
export class ComposeInputError extends Error {}

/** Пустой личный профиль почты: поля есть, значений нет (форма заморожена T33). */
export function EMPTY_MAIL_PROFILE(): Record<string, string | boolean | null> {
  // Значения по умолчанию — как у ядра (task-34): пустой профиль НЕ null.
  return {
    displayName: "",
    signatureText: "",
    signatureEnabled: true,
    signaturePosition: "below",
    replyQuote: true,
    replyAttribution: "ru",
    updatedAt: null
  };
}

/** Отказ ядра по данным профиля: маршрут обязан отдать 400 с его текстом, а не 500. */
export class MailProfileInputError extends Error {}

export function coreMockModule(): Record<string, unknown> {
  const module: Record<string, unknown> = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    // Шифрование секретов: заглушка с тем же контрактом, что у ядра (T51 — пароль каталога).
    getContext: jest.fn(() => ({
      secrets: {
        encrypt: (plain: string) => "ШИФР:" + plain,
        decrypt: (cipher: string) => String(cipher).replace("ШИФР:", "")
      }
    })),
    getAllSettings: jest.fn(() => ({})),
    getSettingValue: jest.fn(() => null),
    getAiConfig: jest.fn(() => ({})),
    getPromptSettings: jest.fn(() => ({})),
    getProgress: jest.fn(() => ({ emailId: null, stage: "idle", queueLength: 0 })),
    // Ящик стенда — с НАСТРОЕННОЙ отправкой: иначе выбор ящика (Р12) останавливал бы
    // отправку, и падал бы не тот тест, который проверяет.
    listAccounts: jest.fn(() => [
      {
        id: "acc-1",
        protocol: "imap",
        host: "mail.test",
        port: 993,
        tls: "ssl",
        username: "stand@mail.test",
        passwordEncrypted: "ШИФР-ПАРОЛЬ",
        authType: "password",
        settings: {},
        smtpHost: "mail.test",
        smtpPort: 465,
        smtpTls: "ssl",
        smtpUsername: "stand@mail.test",
        smtpPasswordEncrypted: null,
        smtpAuthType: "password"
      }
    ]),
    listAttachments: jest.fn(() => []),
    // Поиск ящика по адресу (T50): в ядре сравнение в JS, регистр и пробелы не важны.
    getAccountByUsername: jest.fn(() => null),
    getEmailView: jest.fn(() => null),
    listEmailsWithAnalysis: jest.fn(() => []),
    listThreadsGrouped: jest.fn(() => []),
    listDrafts: jest.fn(() => []),
    listTemplates: jest.fn(() => []),
    importEmails: jest.fn(async () => ({ added: 0, skipped: 0, knownOutOfRange: 0 })),
    // Личный профиль почты (T34/T35): пустой профиль по умолчанию, без ошибки.
    MailProfileInputError,
    getMailProfile: jest.fn(async (userId: string) => ({ ...EMPTY_MAIL_PROFILE(), userId })),
    setMailProfile: jest.fn(async (userId: string, patch: Record<string, unknown>) => ({
      ...EMPTY_MAIL_PROFILE(),
      userId,
      ...patch
    })),
    // Приём писем (T30): у FetchResult есть счётчик известных-вне-диапазона — форма обязана быть полной.
    fetchEmails: jest.fn(async () => ({ added: 0, skipped: 0, knownOutOfRange: 0 })),
    sendEmail: jest.fn(async () => ({ emailId: "sent-1", messageId: "<sent-1@stand.test>" })),
    ComposeInputError,
    // Шаблон письма (T27): маршрут обязан пробросить useAccountSignature как есть.
    buildComposeTemplate: jest.fn((input: Record<string, unknown>) => ({
      accountId: input.accountId,
      mode: input.mode,
      useAccountSignature: input.useAccountSignature,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      bodyText: "",
      bodyHtml: ""
    })),
    buildXlsx: jest.fn(() => Buffer.from("xlsx")),
    exportFileName: jest.fn((name: string) => name + ".xlsx"),
    directoryStatus: jest.fn(() => ({ configured: false, connected: false })),
    // Этап 5: матчинг правил сортировки и рабочие дни. Формы — по контракту §5:
    // пустой результат обязан быть объектом, иначе маршрут упал бы на чтении .matched.
    matchSortRules: jest.fn(() => ({ matched: false, labels: [], notes: [], priority: null, ruleIds: [] })),
    validateSortRule: jest.fn(() => ({ ok: true, errors: [] })),
    addWorkingDays: jest.fn((from: string) => from),
    isWorkingDay: jest.fn(() => true)
  };
  return new Proxy(module, {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (typeof prop !== "string") return undefined;
      if (!(prop in target)) target[prop] = jest.fn(() => undefined);
      return (target as Record<string, unknown>)[prop];
    }
  });
}

/**
 * Подставной пакет документооборота: вход/сессии — в памяти, репозиторий — заглушки.
 * Ошибки и роли берём настоящие, чтобы обработчик ошибок и права вели себя как в бою.
 */
export function docflowMockModule(): Record<string, unknown> {
  const sessions = new Map<string, TestUser>();
  const errors = jest.requireActual("@mailsense/docflow/errors") as Record<string, unknown>;
  const roles = jest.requireActual("@mailsense/docflow/roles") as Record<string, unknown>;
  // Список статусов документа — продуктовый: берём настоящий, чтобы проверка на сервере
  // не разошлась с тем, что принимает журнал.
  const types = jest.requireActual("@mailsense/docflow/types") as Record<string, unknown>;
  const replies = jest.requireActual("@mailsense/docflow/approvalReplies") as Record<string, unknown>;

  const stub = (value: unknown) => jest.fn(async () => value);

  const module: Record<string, unknown> = {
    /** Карта «токен → пользователь»: тест кладёт сюда сессии. */
    __sessions: sessions,
    SESSION_COOKIE: "mailsense_session",

    isDocflowEnabled: jest.fn(async () => true),
    hasDocflowDb: jest.fn(() => true),
    // Старт автономного сервера: адрес базы и «документооборот в PostgreSQL».
    docflowDatabaseUrl: jest.fn(() => null),
    initDocflowDb: jest.fn(async () => undefined),
    installLdapSettingsStore: jest.fn(async () => undefined),
    cleanupSessions: jest.fn(async () => undefined),
    seedLocalAdmin: jest.fn(async () => undefined),
    resolveToken: jest.fn(async (token: string | null) =>
      token ? sessions.get(token) ?? null : null
    ),
    sessionTtlHours: stub(24),
    authStatus: stub({ enabled: true }),
    setDocflowEnabled: jest.fn(async () => undefined),
    // Личные настройки работника (Р24/T52): по умолчанию выбора нет.
    EDMS_WORK_ACCOUNT_SETTING: "edms.workAccountId",
    EDMS_WORK_MAIL_AUDIT_ACTION: "edms.work_mail",
    getUserSetting: jest.fn(async () => null),
    // Выдача ящиков «почты для СЭД» (task-56): по умолчанию ничего не выдано.
    EDMS_ALLOWED_WORK_ACCOUNTS_SETTING: "edms.allowedWorkAccounts",
    EDMS_WORK_MAIL_ALLOWANCE_AUDIT_ACTION: "edms.work_mail_allowance",
    getAllowedWorkAccounts: jest.fn(async () => []),
    setAllowedWorkAccounts: jest.fn(async (_userId: string, accountIds: string[]) => ({
      accountIds,
      resetChoice: null
    })),
    setUserSetting: jest.fn(async (_userId: string, _key: string, value: string | null) => value),
    // Настройки документооборота: свежая база — строки ещё нет (null).
    getSetting: jest.fn(async () => null),
    setSetting: jest.fn(async () => undefined),
    SETTING_DOCFLOW_ENABLED: "docflow.enabled",
    login: stub({ token: "t", user: null, expiresAt: null }),
    logout: stub(undefined),

    // Ошибки и права — настоящие.
    AppError: errors.AppError,
    AuthError: errors.AuthError,
    ForbiddenError: errors.ForbiddenError,
    NotFoundError: errors.NotFoundError,
    isAppError: errors.isAppError,
    hasPermission: roles.hasPermission,
    permissionsOfRoles: roles.permissionsOfRoles,
    isAdmin: roles.isAdmin,
    roleName: roles.roleName,
    ROLE_DEFINITIONS: roles.ROLE_DEFINITIONS,
    DOCUMENT_STATUSES: types.DOCUMENT_STATUSES,
    DOCUMENT_STATUS_TITLES: types.DOCUMENT_STATUS_TITLES,

    // Пользователи и роли.
    listRoles: stub([]),
    listUsersWithRoles: stub([]),
    getUserWithRoles: jest.fn(async (id: string) => ({ id, roles: [] })),
    getUser: jest.fn(async (id: string) => ({ id, fullName: "Пользователь " + id, email: id + "@stand.test" })),
    getUserByEmail: jest.fn(async (email: string) => ({ id: "u-" + email, fullName: "По адресу", email })),
    getUserRoles: stub(["manager"]),
    assignRoles: jest.fn(async (id: string) => ({ id, roles: [] })),
    setUserActive: jest.fn(async (id: string) => ({ id })),
    createManualUser: stub({ id: "created" }),
    updateManualUser: jest.fn(async (id: string) => ({ id })),
    syncDirectoryUsers: stub({ synced: 0 }),

    // Журнал.
    listDocuments: stub({ items: [], total: 0 }),
    listDocumentsForExport: stub([]),
    listDocumentEmails: stub([]),
    getDocument: jest.fn(async (id: string) => ({ id, regNumber: "вх1", emailId: null })),
    getDocumentByEmail: stub(null),
    registerDocument: stub({ id: "doc-1", regNumber: "вх1" }),
    updateDocument: jest.fn(async (id: string) => ({ id, regNumber: "вх1" })),
    documentStatusCounts: stub({}),
    peekNextNumber: stub({ number: "вх1" }),
    // Открытый период по умолчанию — текущий год: закрывать можно только его.
    getNumberingState: stub({
      rules: [],
      openPeriod: String(new Date().getFullYear()),
      archivedPeriods: [],
      reopenablePeriods: [],
      blockedReason: null
    }),
    saveNumberingRule: stub({}),
    archivePeriod: stub(undefined),
    /** Строгое закрытие года: проверки, архив и след — в одной транзакции (ядро). */
    closePeriod: jest.fn(async (input: { period: string; fileName?: string; documentCount?: number }) => ({
      period: input.period,
      fileName: input.fileName ?? "",
      documentCount: input.documentCount ?? 0
    })),
    /** Отмена закрытия года: в ядре проверяется, что в новом году нет документов. */
    reopenPeriod: jest.fn(async (input: { period: string }) => ({ period: input.period })),
    /** Снимок года перед закрытием — вызывается В ПРОЦЕССЕ, не по HTTP. */
    exportPeriodArchive: jest.fn(async (period: string) => "/tmp/archives/journal-" + period + ".zip"),
    archiveFailureText: jest.fn(
      (reason: string) => "Снимок года не сделан — год НЕ закрыт. Причина: " + reason + ". Данные журнала не изменялись."
    ),
    listArchivedPeriods: stub([]),
    listCases: stub([]),
    saveCase: stub({}),
    listCorrespondents: stub([]),
    saveCorrespondent: stub({}),
    findDuplicates: stub([]),
    listRegisteredEmailIds: stub([]),

    // Резолюции.
    listBoard: stub({ items: [], total: 0 }),
    listResolutions: stub({ items: [], total: 0 }),
    listDocumentResolutions: stub([]),
    listMyTasks: stub({ items: [], total: 0 }),
    getResolution: jest.fn(async (id: string) => ({ id, status: "pending_approval", approvedBy: null })),
    getResolutionDetail: jest.fn(async (id: string) => ({
      id,
      documentId: "doc-1",
      documentNumber: "вх1",
      text: "Подготовить ответ",
      deadline: "2026-11-01",
      status: "pending_approval",
      preparedBy: null,
      approvedBy: null,
      confirmedBy: null,
      dispatchedBy: null,
      // ⚠️ Исполнитель по умолчанию — ДРУГОЙ человек: на этой записи проверяется,
      // что чужое поручение не отдаётся (доступ участнику проверяет маршрут).
      assignees: [
        {
          userId: "u-assignee",
          fullName: "Исполнитель",
          email: "u-assignee@stand.test",
          kind: "responsible"
        }
      ]
    })),
    createResolution: stub({ id: "res-1" }),
    updateResolution: stub({ id: "res-1" }),
    requestApproval: stub({ id: "res-1" }),
    approveResolution: stub({ id: "res-1" }),
    forwardToManager: stub({ id: "res-1" }),
    markEmailApproval: stub({ id: "res-1" }),
    confirmEmailApproval: stub({ id: "res-1", status: "approved" }),
    rejectResolution: stub({ id: "res-1" }),
    dispatchResolution: stub({ id: "res-1", status: "sent" }),
    reportExecution: stub({ id: "res-1" }),
    confirmReport: stub({ id: "res-1" }),
    closeResolution: stub({ id: "res-1" }),
    cancelResolution: stub({ id: "res-1" }),
    markTaskReceived: stub(undefined),
    /** Запись письма-поручения: возвращает запись с проставленным идентификатором. */
    attachDispatchEmail: jest.fn(async (id: string, emailId: string) => ({
      id,
      status: "sent",
      dispatchEmailId: emailId
    })),
    /** Запись письма-запроса резолюции: без неё ответ руководителя не сопоставляется. */
    attachRequestEmail: jest.fn(async (id: string, emailId: string) => ({
      id,
      status: "pending_approval",
      requestEmailId: emailId
    })),
    /** Настоящее сопоставление ответов по треду (In-Reply-To/References). */
    matchReplies: replies.matchReplies,
    /** Кандидаты на утверждение/отчёт: в бою их даёт docflow по requestEmailId/dispatchEmailId. */
    listReplyCandidates: stub([]),

    // Архив года: выгрузка потоком и импорт. По умолчанию выгрузка отдаёт минимальный
    // ZIP и закрывает ответ — иначе маршрут в матрице повис бы без тела.
    exportJournalYear: jest.fn(async (opts: { out: { end: (chunk?: unknown) => void } }) => {
      opts.out.end(Buffer.from("PK\u0003\u0004test"));
      return { period: "2026", documents: 0, resolutions: 0, assignees: 0, reports: 0, audit: 0, attachments: 0, files: [] };
    }),
    importJournalArchive: jest.fn(async (opts: { file: string }) => ({
      period: "2026",
      inserted: { documents: 0 },
      skipped: {},
      attachments: 0,
      file: opts.file
    })),
    setJournalAttachmentStore: jest.fn(),
    // Расчёт объёма архива для предупреждения в форме закрытия (истинные функции —
    // в docflow, здесь достаточно заглушек, чтобы маршрут состояния нумерации отвечал).
    ARCHIVE_LIMIT_BYTES: 4 * 1024 ** 3,
    yearEmailLinks: jest.fn(async function* () {
      /* ссылок нет */
    }),
    sumAttachmentBytes: jest.fn(async () => ({ bytes: 0, files: 0, unknownSizes: 0, truncated: false })),
    archiveVolumeWarning: jest.fn(() => ({ level: "ok", text: null })),
    getDocflowPool: () => ({
      connect: jest.fn(async () => ({ query: jest.fn(), release: jest.fn() }))
    }),
    /** Откат отправки: поручение снова ждёт отправки. */
    revertDispatch: jest.fn(async (id: string) => ({ id, status: "approved", dispatchEmailId: null })),

    // Аудит.
    listAudit: stub([]),
    countAudit: stub(0),
    /** Аудит вне транзакции: незаурядные случаи вроде отказа в подписи (прецедент register_denied). */
    writeAudit: jest.fn(async () => null),

    // Task-18: агрегат «профиль исполнителя» (данные под будущую подсказку).
    recomputeUserStats: jest.fn(async () => ({ users: 0, updated: 0, skipped: 0, monthly: 0 })),
    listUserActivityStats: jest.fn(async () => ({ items: [], total: 0, computedAt: null })),
    setUserStatsMailFactsProvider: jest.fn(),

    // Р12: служебный ящик отправки. explicit = «администратор выбор делал» (в т.ч. снял).
    getServiceAccountState: jest.fn(async () => ({ explicit: false, accountId: null })),
    // Ключи настроек ролей служебных ящиков (T25/T51) — те же строки, что в docflow.
    SERVICE_ACCOUNT_SETTING: "docflow.serviceAccountId",
    EXTERNAL_ACCOUNT_SETTING: "docflow.externalAccountId",
    getExternalAccountState: jest.fn(async () => ({ explicit: false, accountId: null })),
    getServiceAccountId: jest.fn(async () => null),
    getExternalAccountId: jest.fn(async () => null),
    setServiceAccountId: jest.fn(async (accountId: string | null) => accountId),
    /** Парная запись двух ролей (T25): undefined — роль не трогаем. */
    setServiceAccounts: jest.fn(async (input: { internal?: string | null; external?: string | null }) => ({
      internal: input?.internal ?? null,
      external: input?.external ?? null
    })),

    // Этап 5: центр уведомлений.
    listNotifications: jest.fn(async () => ({ items: [], unread: 0, total: 0, enabled: true })),
    countUnreadNotifications: jest.fn(async () => 0),
    markNotificationRead: jest.fn(async () => ({ ok: true, unread: 0 })),
    markAllNotificationsRead: jest.fn(async () => 0),
    materializeDeadlineNotificationsSafe: jest.fn(async () => undefined),
    notificationsEnabled: jest.fn(async () => true),
    getNotificationSettings: jest.fn(async () => ({
      enabled: true,
      dueSoonDays: 3,
      workdayDeadlines: true,
      holidays: [] as string[],
      variables: [] as Array<{ key: string; title: string }>,
      templates: []
    })),
    saveNotificationSettings: jest.fn(async () => ({
      enabled: true,
      dueSoonDays: 3,
      workdayDeadlines: true,
      holidays: [] as string[],
      variables: [] as Array<{ key: string; title: string }>,
      templates: []
    })),

    // Этап 5: правила автосортировки.
    listSortRules: jest.fn(async () => []),
    getSortRule: jest.fn(async (id: string) => ({
      id,
      name: "Правило",
      isActive: true,
      sortOrder: 0,
      matchFrom: "поставщик",
      matchTo: "",
      matchSubject: "",
      label: "",
      priority: null,
      note: ""
    })),
    saveSortRule: jest.fn(async (input: { id?: string }) => ({
      id: input?.id ?? "rule-1",
      name: "Правило",
      isActive: true,
      sortOrder: 0,
      matchFrom: "поставщик",
      matchTo: "",
      matchSubject: "",
      label: "",
      priority: null,
      note: ""
    })),
    deleteSortRule: jest.fn(async () => true),
    /** Проверка правил, регистрируемая сервером в хранилище (одна реализация — core). */
    setSortRuleValidator: jest.fn(),
    listDeadlinePresets: jest.fn(async () => [
      { id: "wd-3", title: "3 рабочих дня", days: 3, isWorkday: true, sortOrder: 10 }
    ])
  };
  return module;
}
