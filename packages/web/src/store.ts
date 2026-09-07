import { create } from "zustand";
import { api } from "./api";
import type { Account, AiConfig, AnalysisStatus, Email, EmailView } from "./types";

export type SortBy = "date" | "priority";
export type SortDir = "asc" | "desc";

export interface FilterState {
  categories: string[];
  minPriority: number | null;
  tag: string | null;
  hasEvent: boolean;
  status: AnalysisStatus | null;
  q: string;
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
  categories: [],
  minPriority: null,
  tag: null,
  hasEvent: false,
  status: null,
  q: "",
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
      const s = get();
      const emails = await api.emails({
        folder: s.folder,
        accountId: s.accountFilter ?? undefined,
        categories: s.categories.length ? s.categories : undefined,
        minPriority: s.minPriority ?? undefined,
        tag: s.tag ?? undefined,
        hasEvent: s.hasEvent,
        status: s.status ?? undefined,
        q: s.q || undefined,
        sortBy: s.sortBy,
        sortDir: s.sortDir
      });
      set({ emails });
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
  },

  setAccountFilter: (accountFilter: string | null) => {
    set({ accountFilter });
    void get().loadEmails();
  },

  setFilter: (patch: Partial<FilterState>) => {
    set(patch);
    void get().loadEmails();
  },

  resetFilters: () => {
    set({ categories: [], minPriority: null, tag: null, hasEvent: false, status: null, q: "", sortBy: "date", sortDir: "desc" });
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
