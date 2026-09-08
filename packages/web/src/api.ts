import type {
  Account,
  AccountInput,
  AiConfig,
  Email,
  EmailView
} from "./types";

const BASE = "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
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
  fetchAccount: (id: string, range?: { since?: string; until?: string }) =>
    request<{ added: number; skipped: number }>("/api/accounts/" + id + "/fetch", {
      method: "POST",
      body: JSON.stringify(range ?? {})
    }),

  emails: (filter: {
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
  } = {}) => {
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
    const q = params.toString();
    return request<Email[]>("/api/emails" + (q ? "?" + q : ""));
  },
  email: (id: string) => request<EmailView>("/api/emails/" + id),
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

  settings: () => request<Record<string, string>>("/api/settings"),
  saveSetting: (key: string, value: string) =>
    request<Record<string, string>>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ [key]: value })
    })
};

export function attachmentUrl(emailId: string, attId: string, inline = false): string {
  return BASE + "/api/emails/" + emailId + "/attachments/" + attId + "/file" + (inline ? "?inline=1" : "");
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
