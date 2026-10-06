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
export function coreMockModule(): Record<string, unknown> {
  const module: Record<string, unknown> = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getAllSettings: jest.fn(() => ({})),
    getSettingValue: jest.fn(() => null),
    getAiConfig: jest.fn(() => ({})),
    getPromptSettings: jest.fn(() => ({})),
    getProgress: jest.fn(() => ({ emailId: null, stage: "idle", queueLength: 0 })),
    listAccounts: jest.fn(() => [{ id: "acc-1", protocol: "imap", username: "stand@mail.test" }]),
    listAttachments: jest.fn(() => []),
    getEmailView: jest.fn(() => null),
    listEmailsWithAnalysis: jest.fn(() => []),
    listThreadsGrouped: jest.fn(() => []),
    listDrafts: jest.fn(() => []),
    listTemplates: jest.fn(() => []),
    importEmails: jest.fn(async () => ({ added: 0, skipped: 0 })),
    sendEmail: jest.fn(async () => ({ emailId: "sent-1", messageId: "<sent-1@stand.test>" })),
    buildXlsx: jest.fn(() => Buffer.from("xlsx")),
    exportFileName: jest.fn((name: string) => name + ".xlsx"),
    directoryStatus: jest.fn(() => ({ configured: false, connected: false }))
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
    resolveToken: jest.fn(async (token: string | null) =>
      token ? sessions.get(token) ?? null : null
    ),
    sessionTtlHours: stub(24),
    authStatus: stub({ enabled: true }),
    setDocflowEnabled: stub(undefined),
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
      blockedReason: null
    }),
    saveNumberingRule: stub({}),
    archivePeriod: stub(undefined),
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
    /** Откат отправки: поручение снова ждёт отправки. */
    revertDispatch: jest.fn(async (id: string) => ({ id, status: "approved", dispatchEmailId: null })),

    // Аудит.
    listAudit: stub([]),
    countAudit: stub(0)
  };
  return module;
}
