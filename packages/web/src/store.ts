import { create } from "zustand";
import { api } from "./api";
import { debounce } from "./utils/debounce";
import type {
  Account,
  AiConfig,
  AnalysisStatus,
  AuthStatus,
  AuthUser,
  Draft,
  Email,
  EmailView,
  Permission,
  ThreadGroup
} from "./types";

export type SortBy = "date" | "priority";
export type SortDir = "asc" | "desc";
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** Разделы приложения: почта и рабочие места документооборота. */
export type AppSection =
  | "mail"
  | "journal"
  | "incoming"
  | "approvals"
  | "confirmation"
  | "tasks"
  | "board";

export interface FilterState {
  categories: string[];
  minPriority: number | null;
  tag: string | null;
  hasEvent: boolean;
  status: AnalysisStatus | null;
  q: string;
  from: string[];
  to: string[];
  externalNumber: string[];
  dateFrom: string;
  dateTo: string;
  sendDateFrom: string;
  sendDateTo: string;
  sortBy: SortBy;
  sortDir: SortDir;
}

interface State extends FilterState {
  accounts: Account[];
  emails: Email[];
  folder: string;
  accountFilter: string | null;
  selectedId: string | null;
  emailView: EmailView | null;
  selectedIds: string[];
  /** Письмо, для которого нужно сразу открыть форму регистрации (переход из списка «На регистрацию»). */
  registerIntent: string | null;
  /**
   * Счётчик запусков анализа: по нему индикатор прогресса понимает, что очередь
   * снова не пуста, и возобновляет опрос (в простое он не опрашивает сервер).
   */
  analysisEpoch: number;
  loading: boolean;
  settingsOpen: boolean;
  aiConfig: AiConfig | null;
  compose: { open: boolean; mode: ComposeMode; emailId: string | null; draft: Draft | null };
  openCompose: (mode: ComposeMode, emailId?: string | null) => void;
  /** Открыть композер с уже сохранённым черновиком. */
  openDraftCompose: (draft: Draft) => void;
  closeCompose: () => void;
  draftsOpen: boolean;
  setDraftsOpen: (v: boolean) => void;
  threadView: boolean;
  threads: ThreadGroup[];
  setThreadView: (v: boolean) => void;
  loadThreads: () => Promise<void>;

  // -------- документооборот: вход --------
  /** Состояние входа, известное серверу (включён ли документооборот, настроен ли каталог и т.д.). */
  authStatus: AuthStatus | null;
  /** Текущий пользователь; null — документооборот выключен или вход не выполнен. */
  authUser: AuthUser | null;
  /** Первичная проверка сессии завершена (иначе показываем «загрузку», а не форму входа). */
  authReady: boolean;
  /**
   * Сервер документооборота недоступен. Почта при этом работает: она локальная,
   * поэтому не блокируем приложение, а только прячем функции документооборота.
   */
  docflowUnavailable: boolean;
  loadAuth: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: Permission) => boolean;

  init: () => Promise<void>;
  loadAccounts: () => Promise<void>;
  loadAiConfig: () => Promise<void>;
  loadEmails: () => Promise<void>;
  select: (id: string) => Promise<void>;
  /** Просьба открыть форму регистрации для письма: ставится списком, снимается формой. */
  requestRegister: (emailId: string) => void;
  clearRegisterIntent: () => void;
  refreshSelected: () => Promise<void>;
  setFolder: (f: string) => void;
  setAccountFilter: (id: string | null) => void;
  /**
   * Активный раздел приложения. Роутера нет намеренно: разделы СЭД — это
   * состояние, а не адреса (см. журнал решений, «Роутер: отсутствует»).
   */
  section: AppSection;
  setSection: (s: AppSection) => void;
  setFilter: (patch: Partial<FilterState>) => void;
  resetFilters: () => void;
  fetchAccount: (id: string) => Promise<void>;
  analyze: (id: string) => Promise<void>;
  analyzeAll: () => Promise<void>;
  stopAnalysis: () => Promise<void>;
  setSettingsOpen: (v: boolean) => void;
  moveSelected: (folder: string) => Promise<void>;
  updateAnalysis: (patch: Record<string, unknown>) => Promise<void>;
  toggleSelect: (id: string) => void;
  toggleSelectMany: (ids: string[]) => void;
  clearSelection: () => void;
  bulkAnalyze: () => Promise<void>;
  bulkMove: (folder: string) => Promise<void>;
  bulkDelete: () => Promise<void>;
  selectAll: () => void;
  analyzeRange: (since?: string, until?: string, accountIds?: string[]) => Promise<number>;
  fetchAccounts: (ids: string[], since?: string, until?: string) => Promise<void>;
  importEmails: (accountId: string, folder: string, files: { filename: string; data: string }[]) => Promise<{ added: number; skipped: number }>;
  fetchAccountRange: (id: string, since?: string, until?: string) => Promise<void>;
}

/** Единый фильтр для списка писем и переписок (иначе поиск в тредах терялся). */
function filterParams(s: State) {
  return {
    folder: s.folder,
    accountId: s.accountFilter ?? undefined,
    categories: s.categories.length ? s.categories : undefined,
    minPriority: s.minPriority ?? undefined,
    tag: s.tag ?? undefined,
    hasEvent: s.hasEvent,
    status: s.status ?? undefined,
    q: s.q || undefined,
    from: s.from.length ? s.from : undefined,
    to: s.to.length ? s.to : undefined,
    externalNumber: s.externalNumber.length ? s.externalNumber : undefined,
    dateFrom: s.dateFrom || undefined,
    dateTo: s.dateTo || undefined,
    sendDateFrom: s.sendDateFrom || undefined,
    sendDateTo: s.sendDateTo || undefined,
    sortBy: s.sortBy,
    sortDir: s.sortDir
  };
}

/**
 * Письма, которые пользователь видит в списке прямо сейчас.
 *
 * Массовые действия считаются только по ним: иначе «Удалить» уносит письма,
 * которых на экране нет (они остались выбранными от прежнего фильтра).
 */
export function visibleEmailIds(s: {
  emails: Email[];
  threads: ThreadGroup[];
  threadView: boolean;
}): string[] {
  if (s.threadView) return [...new Set(s.threads.flatMap((t) => t.emails.map((e) => e.id)))];
  return s.emails.map((e) => e.id);
}

/** Оставляет в выборе только видимое; если ничего не изменилось — тот же массив. */
function pruneSelection(selectedIds: string[], visible: string[]): string[] {
  const keep = new Set(visible);
  const next = selectedIds.filter((id) => keep.has(id));
  return next.length === selectedIds.length ? selectedIds : next;
}

/** Выбранное, что реально видно в текущем списке — только по этому и действуем. */
function selectedVisible(s: State): string[] {
  const keep = new Set(visibleEmailIds(s));
  return s.selectedIds.filter((id) => keep.has(id));
}

/** Запрос списка: новый отменяет предыдущий, иначе старый ответ перетрёт свежий. */
let emailsAbort: AbortController | null = null;

/**
 * Перезапрос списка с паузой: поиск идёт по буквам, поэтому «о», «от», «отч»
 * должны превратиться в один запрос, а не в три (и не обогнать друг друга).
 */
const reloadListDebounced = debounce(() => {
  void useStore.getState().loadEmails();
}, 300);
/** То же для открытого письма: быстрое переключение писем не должно подменять открытое. */
let emailAbort: AbortController | null = null;

export const useStore = create<State>()((set, get) => ({
  accounts: [],
  emails: [],
  folder: "INBOX",
  section: "mail",
  accountFilter: null,
  selectedId: null,
  emailView: null,
  selectedIds: [],
  registerIntent: null,
  analysisEpoch: 0,
  loading: false,
  settingsOpen: false,
  aiConfig: null,
  compose: { open: false, mode: "new", emailId: null, draft: null },
  draftsOpen: false,
  threadView: false,
  threads: [],
  categories: [],
  minPriority: null,
  tag: null,
  hasEvent: false,
  status: null,
  q: "",
  from: [],
  to: [],
  externalNumber: [],
  dateFrom: "",
  dateTo: "",
  sendDateFrom: "",
  sendDateTo: "",
  sortBy: "date",
  sortDir: "desc",
  authStatus: null,
  authUser: null,
  authReady: false,
  docflowUnavailable: false,

  loadAuth: async () => {
    try {
      const status = await api.authStatus();
      set({ authStatus: status, docflowUnavailable: false });
      if (!status.docflowEnabled) {
        // Автономный режим: документооборот выключен, входа нет.
        set({ authUser: null, authReady: true });
        return;
      }
      const me = await api.authMe();
      set({ authUser: me.user ?? null, authReady: true });
    } catch (err) {
      // 503 от прокси = сервер документооборота недоступен. Локальная почта
      // обязана продолжать работать, поэтому не показываем экран входа.
      set({ authUser: null, authStatus: null, authReady: true, docflowUnavailable: true });
      console.warn("Документооборот недоступен:", (err as Error).message);
    }
  },

  login: async (login, password) => {
    const res = await api.login(login, password);
    set({ authUser: res.user, authReady: true });
    await get().init();
  },

  logout: async () => {
    await api.logout();
    set({ authUser: null, emails: [], emailView: null, selectedId: null, selectedIds: [] });
  },

  can: (permission) => {
    const s = get();
    // Сервер недоступен — функции документооборота недоступны (но почта работает).
    if (s.docflowUnavailable) return false;
    // Документооборот выключен — ограничений нет (автономный режим).
    if (!s.authStatus?.docflowEnabled) return true;
    return !!s.authUser?.permissions.includes(permission);
  },

  init: async () => {
    await get().loadAccounts();
    // Настройки ИИ закрыты правом settings.manage: остальным ролям запрос возвращал
    // 403 и попадал в консоль браузера как ошибка.
    if (get().can("settings.manage")) await get().loadAiConfig();
    await get().loadEmails();
  },

  loadAccounts: async () => {
    const accounts = await api.accounts();
    set({ accounts });
  },

  loadAiConfig: async () => {
    try {
      set({ aiConfig: await api.aiConfig() });
    } catch {
      /* ignore */
    }
  },

  loadEmails: async () => {
    // Предыдущий запрос списка больше не нужен: его ответ описывает старый фильтр.
    emailsAbort?.abort();
    const ctrl = new AbortController();
    emailsAbort = ctrl;
    set({ loading: true });
    try {
      const emails = await api.emails(filterParams(get()), { signal: ctrl.signal });
      // Отменённый ответ (или ответ, пришедший после отмены) в стор не попадает.
      if (ctrl.signal.aborted) return;
      set({ emails, selectedIds: pruneSelection(get().selectedIds, emails.map((e) => e.id)) });
      if (get().threadView) {
        try {
          await get().loadThreads();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // Отмена — не ошибка: её запросили мы сами, ответ просто устарел.
      if (!ctrl.signal.aborted) throw err;
    } finally {
      if (emailsAbort === ctrl) {
        emailsAbort = null;
        set({ loading: false });
      }
    }
  },

  select: async (id: string) => {
    emailAbort?.abort();
    const ctrl = new AbortController();
    emailAbort = ctrl;
    set({ selectedId: id, emailView: null });
    try {
      const emailView = await api.email(id, { signal: ctrl.signal });
      // Пока грузилось, могли открыть другое письмо — старый ответ не наш.
      if (ctrl.signal.aborted || get().selectedId !== id) return;
      set({ emailView });
    } catch (e) {
      if (!ctrl.signal.aborted) console.error(e);
    }
  },

  refreshSelected: async () => {
    const id = get().selectedId;
    if (!id) return;
    try {
      const emailView = await api.email(id);
      // Фоновая перечитка не должна возвращать на экран письмо, от которого ушли.
      if (get().selectedId !== id) return;
      set({ emailView });
    } catch {
      /* ignore */
    }
  },

  setFolder: (folder: string) => {
    // Смена папки — смена содержимого списка: прежний выбор к нему не относится.
    set({ folder, selectedIds: [] });
    reloadListDebounced.cancel();
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setAccountFilter: (accountFilter: string | null) => {
    set({ accountFilter, selectedIds: [] });
    reloadListDebounced.cancel();
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setFilter: (patch: Partial<FilterState>) => {
    // Фильтр меняет то, что видно на экране, поэтому выбор сбрасываем:
    // иначе массовое действие уходит на письма, которых пользователь не видит.
    set({ ...patch, selectedIds: [] });
    reloadListDebounced();
  },

  resetFilters: () => {
    set({
      selectedIds: [],
      categories: [],
      minPriority: null,
      tag: null,
      hasEvent: false,
      status: null,
      q: "",
      from: [],
      to: [],
      externalNumber: [],
      dateFrom: "",
      dateTo: "",
      sendDateFrom: "",
      sendDateTo: "",
      sortBy: "date",
      sortDir: "desc"
    });
    reloadListDebounced.cancel();
    void get().loadEmails();
  },

  fetchAccount: async (id: string) => {
    await api.fetchAccount(id);
    await get().loadEmails();
  },

  analyze: async (id: string) => {
    set({ analysisEpoch: get().analysisEpoch + 1 });
    await api.analyze(id);
    await get().loadEmails();
  },

  analyzeAll: async () => {
    set({ analysisEpoch: get().analysisEpoch + 1 });
    await api.analyzeAll();
    await get().loadEmails();
  },

  stopAnalysis: async () => {
    set({ analysisEpoch: get().analysisEpoch + 1 });
    await api.stopAnalysis();
    await get().loadEmails();
  },

  setSettingsOpen: (v: boolean) => set({ settingsOpen: v }),
  setSection: (section: AppSection) => set({ section }),
  requestRegister: (emailId) => set({ registerIntent: emailId }),
  clearRegisterIntent: () => set({ registerIntent: null }),

  openCompose: (mode, emailId = null) => set({ compose: { open: true, mode, emailId, draft: null } }),
  openDraftCompose: (draft) => set({ compose: { open: true, mode: "new", emailId: null, draft } }),
  closeCompose: () => set({ compose: { open: false, mode: "new", emailId: null, draft: null } }),
  setDraftsOpen: (v: boolean) => set({ draftsOpen: v }),

  setThreadView: (v: boolean) => {
    set({ threadView: v });
    if (v) void get().loadThreads();
  },
  loadThreads: async () => {
    const threads = await api.threads(filterParams(get()));
    const visible = [...new Set([
      ...get().emails.map((e) => e.id),
      ...threads.flatMap((t) => t.emails.map((e) => e.id))
    ])];
    set({ threads, selectedIds: pruneSelection(get().selectedIds, visible) });
  },

  moveSelected: async (folder: string) => {
    const id = get().selectedId;
    if (!id) return;
    await api.setFolder(id, folder);
    await get().loadEmails();
  },

  updateAnalysis: async (patch: Record<string, unknown>) => {
    const id = get().selectedId;
    if (!id) return;
    await api.updateAnalysis(id, patch);
    await get().refreshSelected();
  },

  toggleSelect: (id: string) => {
    const cur = get().selectedIds;
    set({ selectedIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },

  toggleSelectMany: (ids: string[]) => {
    const cur = get().selectedIds;
    const allSelected = ids.length > 0 && ids.every((id) => cur.includes(id));
    const next = allSelected ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])];
    set({ selectedIds: next });
  },

  clearSelection: () => set({ selectedIds: [] }),

  bulkAnalyze: async () => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    set({ analysisEpoch: get().analysisEpoch + 1 });
    await api.bulkAnalyze(ids);
    await get().loadEmails();
  },

  bulkMove: async (folder: string) => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    await api.bulkFolder(ids, folder);
    set({ selectedIds: [] });
    await get().loadEmails();
  },

  /**
   * Удаление — необратимое действие, поэтому идём строго по видимым письмам:
   * выбранное «из-под другого фильтра» не должно уехать в корзину.
   */
  bulkDelete: async () => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    await api.bulkDelete(ids);
    set({ selectedIds: [], selectedId: null, emailView: null });
    await get().loadEmails();
  },

  selectAll: () => {
    set({ selectedIds: visibleEmailIds(get()) });
  },

  analyzeRange: async (since, until, accountIds) => {
    set({ analysisEpoch: get().analysisEpoch + 1 });
    const r = await api.analyzeRange({ since, until, accountIds });
    await get().loadEmails();
    return r.queued;
  },

  fetchAccounts: async (ids, since, until) => {
    for (const id of ids) {
      await api.fetchAccount(id, { since, until });
    }
    await get().loadEmails();
  },

  importEmails: async (accountId, folder, files) => {
    return api.importEmails(accountId, folder, files);
  },

  fetchAccountRange: async (id, since, until) => {
    await api.fetchAccount(id, { since, until });
    await get().loadEmails();
  }
}));
