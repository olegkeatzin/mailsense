import { create } from "zustand";
import { api } from "./api";
import type { Account, AiConfig, AnalysisStatus, Draft, Email, EmailView, ThreadGroup } from "./types";

export type SortBy = "date" | "priority";
export type SortDir = "asc" | "desc";
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

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

  init: () => Promise<void>;
  loadAccounts: () => Promise<void>;
  loadAiConfig: () => Promise<void>;
  loadEmails: () => Promise<void>;
  select: (id: string) => Promise<void>;
  refreshSelected: () => Promise<void>;
  setFolder: (f: string) => void;
  setAccountFilter: (id: string | null) => void;
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

export const useStore = create<State>()((set, get) => ({
  accounts: [],
  emails: [],
  folder: "INBOX",
  accountFilter: null,
  selectedId: null,
  emailView: null,
  selectedIds: [],
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

  init: async () => {
    await get().loadAccounts();
    await get().loadAiConfig();
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
    set({ loading: true });
    try {
      const emails = await api.emails(filterParams(get()));
      set({ emails });
      if (get().threadView) {
        try {
          await get().loadThreads();
        } catch {
          /* ignore */
        }
      }
    } finally {
      set({ loading: false });
    }
  },

  select: async (id: string) => {
    set({ selectedId: id, emailView: null });
    try {
      const emailView = await api.email(id);
      set({ emailView });
    } catch (e) {
      console.error(e);
    }
  },

  refreshSelected: async () => {
    const id = get().selectedId;
    if (!id) return;
    try {
      const emailView = await api.email(id);
      set({ emailView });
    } catch {
      /* ignore */
    }
  },

  setFolder: (folder: string) => {
    set({ folder });
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setAccountFilter: (accountFilter: string | null) => {
    set({ accountFilter });
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setFilter: (patch: Partial<FilterState>) => {
    set(patch);
    void get().loadEmails();
  },

  resetFilters: () => {
    set({
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
    void get().loadEmails();
  },

  fetchAccount: async (id: string) => {
    await api.fetchAccount(id);
    await get().loadEmails();
  },

  analyze: async (id: string) => {
    await api.analyze(id);
    await get().loadEmails();
  },

  analyzeAll: async () => {
    await api.analyzeAll();
    await get().loadEmails();
  },

  stopAnalysis: async () => {
    await api.stopAnalysis();
    await get().loadEmails();
  },

  setSettingsOpen: (v: boolean) => set({ settingsOpen: v }),

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
    set({ threads });
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
    await api.bulkAnalyze(get().selectedIds);
    await get().loadEmails();
  },

  bulkMove: async (folder: string) => {
    await api.bulkFolder(get().selectedIds, folder);
    set({ selectedIds: [] });
    await get().loadEmails();
  },

  bulkDelete: async () => {
    await api.bulkDelete(get().selectedIds);
    set({ selectedIds: [], selectedId: null, emailView: null });
    await get().loadEmails();
  },

  selectAll: () => {
    set({ selectedIds: get().emails.map((e) => e.id) });
  },

  analyzeRange: async (since, until, accountIds) => {
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
