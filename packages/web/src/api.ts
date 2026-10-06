import type {
  Account,
  AccountInput,
  AiConfig,
  AuditEntry,
  AuthStatus,
  AuthUser,
  CaseRecord,
  ComposeInput,
  ComposeTemplate,
  DocumentCard,
  DocumentPage,
  DocumentRecord,
  Draft,
  DuplicateMatch,
  Email,
  DirectoryContact,
  DirectoryStatus,
  EmailView,
  IncomingItem,
  JournalFilter,
  LdapSettings,
  NumberingRuleRecord,
  NumberingState,
  RegisterSuggest,
  Role,
  Template,
  ThreadGroup,
  User
} from "./types";
import type {
  AssigneeKind,
  BoardColumn,
  ReplyContextItem,
  Resolution,
  ResolutionPriority,
  TaskItem
} from "./resolutionTypes";

const BASE = "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    // Сессия документооборот живёт в HttpOnly-cookie — без credentials её не будет.
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface EmailFilter {
  folder?: string;
  accountId?: string;
  categories?: string[];
  minPriority?: number;
  tag?: string;
  hasEvent?: boolean;
  status?: string;
  q?: string;
  from?: string[];
  to?: string[];
  externalNumber?: string[];
  dateFrom?: string;
  dateTo?: string;
  sendDateFrom?: string;
  sendDateTo?: string;
  sortBy?: string;
  sortDir?: string;
}

/** Общий query-фильтр для /api/emails и /api/threads. */
function emailQuery(filter: EmailFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.folder) params.set("folder", filter.folder);
  if (filter.accountId) params.set("accountId", filter.accountId);
  if (filter.categories?.length) params.set("categories", filter.categories.join(","));
  if (filter.minPriority) params.set("minPriority", String(filter.minPriority));
  if (filter.tag) params.set("tag", filter.tag);
  if (filter.hasEvent) params.set("hasEvent", "1");
  if (filter.status) params.set("status", filter.status);
  if (filter.q) params.set("q", filter.q);
  if (filter.from?.length) params.set("from", filter.from.join(","));
  if (filter.to?.length) params.set("to", filter.to.join(","));
  if (filter.externalNumber?.length) params.set("externalNumber", filter.externalNumber.join(","));
  if (filter.dateFrom) params.set("dateFrom", filter.dateFrom);
  if (filter.dateTo) params.set("dateTo", filter.dateTo);
  if (filter.sendDateFrom) params.set("sendDateFrom", filter.sendDateFrom);
  if (filter.sendDateTo) params.set("sendDateTo", filter.sendDateTo);
  if (filter.sortBy) params.set("sortBy", filter.sortBy);
  if (filter.sortDir) params.set("sortDir", filter.sortDir);
  return params.toString();
}

const withQuery = (q: string) => (q ? "?" + q : "");

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),

  accounts: () => request<Account[]>("/api/accounts"),
  createAccount: (input: AccountInput) =>
    request<Account>("/api/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (id: string, input: AccountInput) =>
    request<Account>("/api/accounts/" + id, { method: "PUT", body: JSON.stringify(input) }),
  deleteAccount: (id: string) => request<{ ok: boolean }>("/api/accounts/" + id, { method: "DELETE" }),
  testAccount: (input: AccountInput) =>
    request<{ ok: boolean; error?: string }>("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  testSmtp: (id: string) =>
    request<{ ok: boolean; error?: string }>("/api/accounts/" + id + "/test-smtp", { method: "POST" }),
  fetchAccount: (id: string, range?: { since?: string; until?: string }) =>
    request<{ added: number; skipped: number }>("/api/accounts/" + id + "/fetch", {
      method: "POST",
      body: JSON.stringify(range ?? {})
    }),

  /** `init.signal` — отмена: список перезапрашивается на каждое изменение фильтра, старый ответ не нужен. */
  emails: (filter: EmailFilter = {}, init?: RequestInit) =>
    request<Email[]>("/api/emails" + withQuery(emailQuery(filter)), init),
  email: (id: string, init?: RequestInit) => request<EmailView>("/api/emails/" + id, init),
  composeTemplate: (accountId: string, mode: string, emailId?: string | null) => {
    const params = new URLSearchParams({ accountId, mode });
    if (emailId) params.set("emailId", emailId);
    return request<ComposeTemplate>("/api/compose-template?" + params.toString());
  },
  threads: (filter: EmailFilter = {}, init?: RequestInit) =>
    request<ThreadGroup[]>("/api/threads" + withQuery(emailQuery(filter)), init),
  setFolder: (id: string, folder: string) =>
    request<{ ok: boolean }>("/api/emails/" + id + "/folder", {
      method: "PATCH",
      body: JSON.stringify({ folder })
    }),
  setExternalNumber: (id: string, externalNumber: string | null) =>
    request<{ ok: boolean; externalNumber: string | null }>("/api/emails/" + id + "/external-number", {
      method: "PATCH",
      body: JSON.stringify({ externalNumber })
    }),
  setSendDate: (id: string, sendDate: string | null) =>
    request<{ ok: boolean; sendDate: string | null }>("/api/emails/" + id + "/send-date", {
      method: "PATCH",
      body: JSON.stringify({ sendDate })
    }),
  analyze: (id: string) =>
    request<{ ok: boolean }>("/api/emails/" + id + "/analyze", { method: "POST" }),
  analyzeAll: () => request<{ queued: number }>("/api/emails/analyze-all", { method: "POST" }),
  analyzeRange: (range?: { since?: string; until?: string; accountIds?: string[] }) =>
    request<{ queued: number }>("/api/emails/analyze-range", { method: "POST", body: JSON.stringify(range ?? {}) }),
  stopAnalysis: () => request<{ cleared: number }>("/api/emails/analyze-stop", { method: "POST" }),
  progress: () =>
    request<{
      emailId: string | null;
      stage: "idle" | "attachment" | "analysis";
      attachmentName: string;
      page: number;
      totalPages: number;
      queueLength: number;
      done: number;
      total: number;
    }>("/api/analysis/progress"),
  bulkAnalyze: (ids: string[]) =>
    request<{ queued: number }>("/api/emails/bulk/analyze", { method: "POST", body: JSON.stringify({ ids }) }),
  bulkFolder: (ids: string[], folder: string) =>
    request<{ ok: boolean }>("/api/emails/bulk/folder", { method: "POST", body: JSON.stringify({ ids, folder }) }),
  bulkDelete: (ids: string[]) =>
    request<{ deleted: number }>("/api/emails/bulk/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  importEmails: (accountId: string, folder: string, files: { filename: string; data: string }[]) =>
    request<{ added: number; skipped: number }>("/api/import", {
      method: "POST",
      body: JSON.stringify({ accountId, folder, files })
    }),

  sendEmail: (compose: ComposeInput) =>
    request<{ emailId: string; messageId: string }>("/api/emails/send", {
      method: "POST",
      body: JSON.stringify(compose)
    }),
  drafts: (accountId?: string) =>
    request<Draft[]>("/api/drafts" + (accountId ? "?accountId=" + encodeURIComponent(accountId) : "")),
  createDraft: (draft: Partial<Draft> & { accountId: string }) =>
    request<Draft>("/api/drafts", { method: "POST", body: JSON.stringify(draft) }),
  updateDraft: (id: string, patch: Record<string, unknown>) =>
    request<Draft>("/api/drafts/" + id, { method: "PUT", body: JSON.stringify(patch) }),
  deleteDraft: (id: string) =>
    request<{ ok: boolean }>("/api/drafts/" + id, { method: "DELETE" }),

  templates: (accountId?: string) =>
    request<Template[]>("/api/templates" + (accountId ? "?accountId=" + encodeURIComponent(accountId) : "")),
  createTemplate: (tpl: Partial<Template> & { name: string }) =>
    request<Template>("/api/templates", { method: "POST", body: JSON.stringify(tpl) }),
  updateTemplate: (id: string, patch: Partial<Template>) =>
    request<Template>("/api/templates/" + id, { method: "PUT", body: JSON.stringify(patch) }),
  deleteTemplate: (id: string) =>
    request<{ ok: boolean }>("/api/templates/" + id, { method: "DELETE" }),

  directoryStatus: () => request<DirectoryStatus>("/api/directory/status"),
  saveLdapSettings: (patch: Partial<LdapSettings>) =>
    request<LdapSettings>("/api/directory/settings", { method: "PUT", body: JSON.stringify(patch) }),
  directoryLogin: (login: string, password: string) =>
    request<DirectoryStatus>("/api/directory/login", { method: "POST", body: JSON.stringify({ login, password }) }),
  directoryLogout: () => request<DirectoryStatus>("/api/directory/logout", { method: "POST" }),
  directoryRefresh: () => request<{ synced: number }>("/api/directory/refresh", { method: "POST" }),
  searchContacts: (q: string, limit = 25) =>
    request<DirectoryContact[]>("/api/contacts/search?q=" + encodeURIComponent(q) + "&limit=" + limit),

  updateAnalysis: (emailId: string, patch: Record<string, unknown>) =>
    request("/api/analysis/" + emailId, { method: "PATCH", body: JSON.stringify(patch) }),

  aiConfig: () => request<AiConfig>("/api/ai/config"),
  saveAiConfig: (cfg: Partial<AiConfig>) =>
    request<AiConfig>("/api/ai/config", { method: "PUT", body: JSON.stringify(cfg) }),
  testAi: (cfg: { baseUrl?: string; apiKey?: string }) =>
    request<{ ok: boolean; models?: string[]; error?: string }>("/api/ai/test", {
      method: "POST",
      body: JSON.stringify(cfg)
    }),
  promptConfig: () => request<{ system: string; userTemplate: string }>("/api/ai/prompt"),
  savePromptConfig: (p: { system?: string; userTemplate?: string }) =>
    request<{ system: string; userTemplate: string }>("/api/ai/prompt", {
      method: "PUT",
      body: JSON.stringify(p)
    }),

  // -------- документооборот: вход и пользователи --------
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  authMe: () => request<{ docflowEnabled: boolean; user: AuthUser | null }>("/api/auth/me"),
  login: (login: string, password: string) =>
    request<{ user: AuthUser; expiresAt: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password })
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  roles: () => request<Role[]>("/api/roles"),
  users: (opts: { q?: string; roleId?: string; includeInactive?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.roleId) p.set("roleId", opts.roleId);
    if (opts.includeInactive) p.set("includeInactive", "1");
    const qs = p.toString();
    return request<User[]>("/api/users" + (qs ? "?" + qs : ""));
  },
  createUser: (u: { email: string; fullName?: string; department?: string; position?: string; phone?: string; roleIds?: string[] }) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(u) }),
  updateUser: (id: string, patch: Record<string, unknown>) =>
    request<User>("/api/users/" + id, { method: "PATCH", body: JSON.stringify(patch) }),
  setUserRoles: (id: string, roleIds: string[]) =>
    request<User>("/api/users/" + id + "/roles", { method: "PUT", body: JSON.stringify({ roleIds }) }),
  syncUsers: () =>
    request<{ total: number; created: number; updated: number; deactivated: number; linked: number }>(
      "/api/users/sync",
      { method: "POST" }
    ),
  saveDocflowSettings: (patch: { enabled?: boolean; sessionTtlHours?: number; localLoginEnabled?: boolean }) =>
    request<AuthStatus>("/api/docflow/settings", { method: "PUT", body: JSON.stringify(patch) }),
  audit: (filter: Record<string, string | number | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return request<{ entries: AuditEntry[]; total: number }>("/api/audit" + (qs ? "?" + qs : ""));
  },

// -------- Журнал регистрации (СЭД, этап 2) --------
  journal: (filter: JournalFilter = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
    }
    const qs = p.toString();
    return request<DocumentPage>("/api/docflow/journal" + (qs ? "?" + qs : ""));
  },
  document: (id: string) => request<DocumentCard>("/api/docflow/journal/" + id),
  documentByEmail: (emailId: string) =>
    request<DocumentRecord | null>("/api/docflow/journal/by-email/" + encodeURIComponent(emailId)),
  registerDocument: (input: Record<string, unknown>) =>
    request<DocumentRecord>("/api/docflow/journal", { method: "POST", body: JSON.stringify(input) }),
  updateDocument: (id: string, patch: Record<string, unknown>) =>
    request<DocumentRecord>("/api/docflow/journal/" + id, { method: "PATCH", body: JSON.stringify(patch) }),
  journalDuplicates: (filter: { emailId?: string; docNumber?: string; summary?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return request<DuplicateMatch[]>("/api/docflow/journal/duplicates" + (qs ? "?" + qs : ""));
  },
  /** Какой входящий номер будет присвоен — подсказка; счётчик при этом не двигается. */
  nextRegNumber: () => request<{ regNumber: string; period: string }>("/api/docflow/journal/next-number"),
  journalSuggest: (emailId: string) =>
    request<RegisterSuggest>("/api/docflow/journal/suggest?emailId=" + encodeURIComponent(emailId)),
  journalIncoming: (limit = 100) =>
    request<{ items: IncomingItem[]; total: number }>("/api/docflow/journal/incoming?limit=" + limit),
  journalStatusCounts: () => request<Record<string, number>>("/api/docflow/journal/status-counts"),
  /** Ссылка на выгрузку: скачивание делает браузер, а не fetch. */
  journalExportUrl: (filter: JournalFilter = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
    }
    const qs = p.toString();
    return "/api/docflow/journal/export" + (qs ? "?" + qs : "");
  },
  auditExportUrl: (filter: Record<string, string | number | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return "/api/audit/export" + (qs ? "?" + qs : "");
  },
  numbering: (period?: string) =>
    request<NumberingState>("/api/docflow/numbering" + (period ? "?period=" + period : "")),
  saveNumbering: (rule: NumberingRuleRecord) =>
    request<NumberingRuleRecord>("/api/docflow/numbering", { method: "PUT", body: JSON.stringify(rule) }),
  archivePeriod: (period: string, fileName?: string) =>
    request<{ ok: boolean; period: string; documentCount: number }>("/api/docflow/numbering/archive", {
      method: "POST",
      body: JSON.stringify({ period, fileName })
    }),
  cases: (onlyActive = false) =>
    request<CaseRecord[]>("/api/docflow/cases" + (onlyActive ? "?active=1" : "")),
  saveCase: (c: Partial<CaseRecord> & { code: string }) =>
    request<CaseRecord>("/api/docflow/cases", { method: "POST", body: JSON.stringify(c) }),

  settings: () => request<Record<string, string>>("/api/settings"),
  saveSetting: (key: string, value: string) =>
    request<Record<string, string>>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ [key]: value })
    })
};


/**
 * Резолюции (СЭД, этап 3).
 *
 * Разделены по шагам процесса: аппарат готовит и отправляет, подписант утверждает,
 * исполнитель получает задачу. Сервер проверяет права независимо — здесь только удобство.
 */
export const resolutionApi = {
  /** ИИ предлагает текст черновика по письму-источнику документа. */
  draft(documentId: string) {
    return request<{ text: string; attachments: number; reason?: string }>("/api/docflow/resolutions/draft", {
      method: "POST",
      body: JSON.stringify({ documentId })
    });
  },

  create(input: {
    documentId: string;
    text: string;
    sourceText?: string;
    sourceKind?: "manual" | "ai";
    priority?: ResolutionPriority;
    deadline?: string | null;
    assignees: Array<{ userId: string; kind: AssigneeKind }>;
  }) {
    return request<Resolution>("/api/docflow/resolutions", { method: "POST", body: JSON.stringify(input) });
  },

  update(
    id: string,
    patch: {
      text?: string;
      priority?: ResolutionPriority;
      deadline?: string | null;
      assignees?: Array<{ userId: string; kind: AssigneeKind }>;
    }
  ) {
    return request<Resolution>("/api/docflow/resolutions/" + id, { method: "PATCH", body: JSON.stringify(patch) });
  },

  get(id: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id);
  },

  byDocument(documentId: string) {
    return request<Resolution[]>("/api/docflow/resolutions/by-document/" + documentId);
  },

  requestApproval(id: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/request-approval", { method: "POST", body: "{}" });
  },

  /** Утверждение вместе с решением: руководитель пишет текст и назначает исполнителя (Р8). */
  approve(
    id: string,
    opts: {
      comment?: string;
      text?: string;
      assignees?: Array<{ userId: string; kind: AssigneeKind }>;
      priority?: ResolutionPriority;
      deadline?: string | null;
    } = {}
  ) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/approve", {
      method: "POST",
      body: JSON.stringify(opts)
    });
  },

  /** Аппарат направляет письмо руководителю: резолюции ещё нет, решает он. */
  forward(documentId: string, toUserId: string) {
    return request<Resolution & { sentTo?: string; sentEmailId?: string }>("/api/docflow/resolutions/forward", {
      method: "POST",
      body: JSON.stringify({ documentId, toUserId })
    });
  },

  /** Способ В, шаг 1: зафиксировать, что подписант ответил письмом. */
  emailApproval(id: string, emailId: string, replyText: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/email-approval", {
      method: "POST",
      body: JSON.stringify({ emailId, replyText })
    });
  },

  /**
   * Способ В, шаг 2: аппарат проверил ответ подписанта и подтвердил.
   *
   * Вместе с подтверждением аппарат вписывает текст (обычно это слова руководителя,
   * подставленные в форму) и назначает исполнителя: фамилию из письма машина разобрать
   * не может, а поручение без исполнителя не уйдёт.
   */
  confirm(
    id: string,
    approvedBy?: string | null,
    opts: {
      text?: string;
      assignees?: Array<{ userId: string; kind: AssigneeKind }>;
      priority?: ResolutionPriority;
      deadline?: string | null;
    } = {}
  ) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/confirm", {
      method: "POST",
      body: JSON.stringify({ approvedBy, ...opts })
    });
  },

  reject(id: string, comment: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/reject", {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  dispatch(id: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/dispatch", { method: "POST", body: "{}" });
  },

  cancel(id: string, comment: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/cancel", {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  /** Очередь подписанта: и ожидающие решения, и уже ответившие письмом. */
  forApproval() {
    return request<{ items: Resolution[]; total: number }>("/api/docflow/resolutions/for-approval");
  },


  /** Отчёт исполнителя об исполнении: описывает, что сделано (этап 4). */
  report(id: string, text: string, emailId?: string | null) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/report", {
      method: "POST",
      body: JSON.stringify({ text, emailId })
    });
  },

  /** Закрытие поручения аппаратом: исполнитель отчитался письмом или лично. */
  close(id: string, comment: string) {
    return request<Resolution>("/api/docflow/resolutions/" + id + "/close", {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },



  /** В переписке ли письмо и по какому поручению — факт из заголовков, а не догадка. */
  replyContext(emailId: string) {
    return request<ReplyContextItem[]>("/api/docflow/emails/" + emailId + "/reply-context");
  },

  /**
   * Черновик полей по тексту письма. Модель вызывается ТОЛЬКО здесь — по нажатию кнопки:
   * письма она не разбирает, аппарат решает сам, что это за письмо.
   */
  suggestFields(emailId: string, kind: "approval" | "report") {
    return request<{ text: string; source: "ai" | "none" }>(
      "/api/docflow/emails/" + emailId + "/suggest-fields",
      { method: "POST", body: JSON.stringify({ kind }) }
    );
  },

  /** Аппарат отметил письмо как резолюцию руководителя — это и есть подтверждение. */
  markApproval(
    resolutionId: string,
    opts: {
      emailId: string;
      text?: string;
      assignees?: Array<{ userId: string; kind: AssigneeKind }>;
      deadline?: string | null;
      priority?: ResolutionPriority;
    }
  ) {
    return request<Resolution>("/api/docflow/resolutions/" + resolutionId + "/mark-approval", {
      method: "POST",
      body: JSON.stringify(opts)
    });
  },

  /** Принять отчёт: текст можно поправить — дальше срабатывает правило закрытия. */
  confirmReport(resolutionId: string, userId: string, text?: string) {
    return request<Resolution>("/api/docflow/resolutions/" + resolutionId + "/report/confirm", {
      method: "POST",
      body: JSON.stringify({ userId, text })
    });
  },

  /** Очередь аппарата: ответы руководителя, ждущие подтверждения разбора (Р9). */
  forConfirmation() {
    return request<{ items: Resolution[]; total: number }>("/api/docflow/resolutions/for-confirmation");
  },

  myTasks() {
    return request<TaskItem[]>("/api/docflow/resolutions/my-tasks");
  },

  /** «Расписка»: исполнитель получил документ (графа 8 журнала). */
  markReceived(id: string) {
    return request<{ ok: boolean }>("/api/docflow/resolutions/" + id + "/received", { method: "POST", body: "{}" });
  },

  /** Ссылка на .ics задачи: календарь сам напомнит о сроке (Р11). */
  icsUrl(id: string) {
    return "/api/docflow/resolutions/" + id + "/ics";
  },

  board() {
    return request<BoardColumn[]>("/api/docflow/resolutions/board");
  },

  /**
   * Кандидаты в исполнители для выбора. Не `/api/users`: тот только для администратора,
   * а выбирать исполнителей должны и аппарат, и руководитель.
   */
  executorCandidates() {
    return request<Array<{ id: string; fullName: string; email: string; department: string }>>(
      "/api/docflow/resolutions/executor-candidates"
    );
  },

  /**
   * Подсказка исполнителей. Сейчас всегда `ready: false` — граф знаний ещё не построен (Р14).
   * Форма ответа зафиксирована заранее, чтобы интерфейс не переделывать.
   */
  suggestAssignees(documentId: string) {
    return request<{
      ready: boolean;
      collected: number;
      needed: number;
      items: Array<{ userId: string; fullName: string; reason: string; confidence: number }>;
      reason?: string;
    }>("/api/docflow/resolutions/suggest-assignees?documentId=" + encodeURIComponent(documentId));
  },
};

export function attachmentUrl(emailId: string, attId: string, inline = false): string {
  return BASE + "/api/emails/" + emailId + "/attachments/" + attId + "/file" + (inline ? "?inline=1" : "");
}

/**
 * Вложение из шаблона пересылки: данных в нём нет — только ссылка на файл письма.
 * Раньше сервер вкладывал вложение целиком в base64, и письмо на 20 МБ
 * превращалось в ~27 МБ JSON, который клиент держал в состоянии.
 */
export interface AttachmentRef {
  emailId: string;
  attachmentId: string;
}

/** Вложение в окне письма: данные уже есть (выбрал человек / пришло из черновика) либо есть ссылка. */
export interface ComposerAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data?: string;
  ref?: AttachmentRef;
}

/** Вложение, готовое к отправке и к записи в черновик. */
export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}

/**
 * Байты → base64. Кодируем кусками: у файла в десятки мегабайт
 * `String.fromCharCode(...bytes)` упирается в предел числа аргументов и роняет вкладку.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Тянет файл вложения письма и кодирует его в base64 — ровно в момент отправки. */
export async function attachmentBase64(emailId: string, attachmentId: string): Promise<string> {
  const res = await fetch(attachmentUrl(emailId, attachmentId), { credentials: "include" });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* тело не JSON — показываем статус */
    }
    throw new Error(msg);
  }
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
}

/**
 * Готовит вложения к отправке и к сохранению черновика.
 *
 * ⚠️ Вложение, которое не удалось достать, — это ошибка, а не «письмо без файла»:
 * человек видит файл в окне и уверен, что он уйдёт. Поэтому не пропускаем, а
 * бросаем исключение — вызывающий обязан показать его и ничего не отправлять.
 */
export async function materializeAttachments(
  items: ComposerAttachment[],
  load: (emailId: string, attachmentId: string) => Promise<string> = attachmentBase64
): Promise<OutgoingAttachment[]> {
  const out: OutgoingAttachment[] = [];
  for (const item of items) {
    let data = item.data;
    if (data === undefined && item.ref) {
      try {
        data = await load(item.ref.emailId, item.ref.attachmentId);
      } catch (err) {
        throw new Error("Не удалось приложить «" + item.filename + "»: " + (err as Error).message);
      }
    }
    if (typeof data !== "string") {
      throw new Error("Вложение «" + item.filename + "» не загружено — приложите файл заново");
    }
    out.push({
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size || Math.floor((data.length * 3) / 4),
      data
    });
  }
  return out;
}

export function previewUrl(emailId: string, attId: string, page?: number): string {
  return (
    BASE +
    "/api/emails/" + emailId + "/attachments/" + attId + "/preview" +
    (page && page > 1 ? "?page=" + page : "")
  );
}

export function icsUrl(emailId: string): string {
  return BASE + "/api/emails/" + emailId + "/ics";
}
