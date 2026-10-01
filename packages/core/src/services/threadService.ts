import {
  clearThreadsForAccount,
  createThread,
  deleteThread,
  findEmailsReferencing,
  findEmailByMessageId,
  findThreadByNormalizedSubject,
  listAccountIds,
  listEmails,
  listEmailsWithAnalysis,
  listEmailsWithAnalysisByThreadIds,
  reassignEmailsThread,
  setEmailThread,
  touchThread,
  type EmailListItem,
  type EmailListFilter
} from "../repos.js";
import { normalizeMessageId } from "../mail/parser.js";
import type { Email } from "../types.js";

/**
 * Ключи-префиксы ответов/пересылок, которые срезаются при нормализации темы.
 * Покрывает русские, английские и немецкие клиенты; допускает вложенные «Re: Re:».
 */
const REPLY_TOKEN = /(^|[\s\[\(])((re|fw|fwd|aw|sv|antw|vs|ответ|переслано|пересл|відповідь))\s*(\[\d+\])?\s*:\s*/gi;

function stripReplyPrefixes(subject: string): string {
  let prev = subject ?? "";
  let cur = prev;
  let guard = 0;
  do {
    prev = cur;
    cur = prev.replace(REPLY_TOKEN, "$1");
    guard++;
  } while (cur !== prev && guard < 10);
  return cur.replace(/\s+/g, " ").trim();
}

/** Есть ли в теме признак ответа/пересылки (даже если префикс не в начале). */
export function hasReplyPrefix(subject: string): boolean {
  const re = new RegExp(REPLY_TOKEN.source, "i");
  return re.test(subject ?? "");
}

/** Базовая тема: срезает Re:/Fwd:/Ответ: (в т.ч. вложенные) без смены регистра. */
export function baseSubject(subject: string): string {
  return stripReplyPrefixes(subject) || subject;
}

/** Нормализация темы: срезает префиксы ответов и приводит к нижнему регистру. */
export function normalizeSubject(subject: string): string {
  return stripReplyPrefixes(subject).toLowerCase();
}

function unique(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** Гарантирует, что у письма-родителя есть беседа. */
function ensureThreadForParent(parent: Email, messageId: string): string {
  if (parent.threadId) return parent.threadId;
  const thread = createThread(
    parent.accountId,
    parent.messageId || messageId,
    normalizeSubject(parent.subject)
  );
  setEmailThread(parent.id, thread.id);
  return thread.id;
}

/** Сливает беседу src в dst (перенося письма) и удаляет src. */
export function mergeThreads(srcThreadId: string | null | undefined, dstThreadId: string): void {
  if (!srcThreadId || !dstThreadId || srcThreadId === dstThreadId) return;
  reassignEmailsThread(srcThreadId, dstThreadId);
  deleteThread(srcThreadId);
}

/** Привязывает письма, которые ссылаются на данное (родитель пришёл позже детей). */
function adoptReferencingEmails(email: Email, threadId: string): void {
  const norm = normalizeMessageId(email.messageId);
  if (!norm) return;
  for (const other of findEmailsReferencing(email.accountId, norm)) {
    if (other.id === email.id) continue;
    if (other.threadId && other.threadId !== threadId) {
      mergeThreads(other.threadId, threadId);
    } else if (!other.threadId) {
      setEmailThread(other.id, threadId);
    }
    touchThread(threadId, other.date ?? other.createdAt);
  }
}

/**
 * Привязывает письмо к беседе:
 *  1. точный матч In-Reply-To / References на письмо в БД (при нескольких — беседы сливаются);
 *  2. фолбэк по нормализованной теме, если письмо выглядит ответом/пересылкой;
 *  3. иначе — новая беседа.
 * Дополнительно «усыновляет» письма, которые ссылаются на это (родитель мог прийти позже).
 * Работает одинаково для IMAP и POP3 — используются только заголовки письма.
 */
export function assignThread(email: Email): string {
  const accountId = email.accountId;
  const refs = (email.references ?? []).map(normalizeMessageId).filter(Boolean);
  const candidates = unique([normalizeMessageId(email.inReplyTo ?? ""), ...refs.slice().reverse()]);

  const matchedThreads: string[] = [];
  for (const mid of candidates) {
    const parent = findEmailByMessageId(accountId, mid);
    if (!parent) continue;
    const tid = ensureThreadForParent(parent, mid);
    if (!matchedThreads.includes(tid)) matchedThreads.push(tid);
  }

  let threadId: string;
  if (matchedThreads.length > 0) {
    threadId = matchedThreads[0];
    for (const other of matchedThreads) mergeThreads(other, threadId);
  } else {
    let bySubject: string | null = null;
    if (refs.length > 0 || email.inReplyTo || hasReplyPrefix(email.subject)) {
      bySubject = findThreadByNormalizedSubject(accountId, normalizeSubject(email.subject))?.id ?? null;
    }
    threadId = bySubject ?? createThread(accountId, email.messageId, normalizeSubject(email.subject)).id;
  }

  setEmailThread(email.id, threadId);
  touchThread(threadId, email.date ?? email.createdAt);
  adoptReferencingEmails(email, threadId);
  return threadId;
}

/**
 * Пересобирает беседы аккаунта (или всех аккаунтов) с нуля.
 * Использует union-find по ссылкам и темам — O(n) запросов вместо O(n²),
 * что важно на больших ящиках (тысячи писем).
 */
export function rebuildThreads(accountId?: string): number {
  const ids = accountId ? [accountId] : listAccountIds();
  let processed = 0;
  for (const acc of ids) {
    clearThreadsForAccount(acc);
    const emails = listEmails({ accountId: acc })
      .slice()
      .sort((a, b) => (a.date ?? a.createdAt).localeCompare(b.date ?? b.createdAt));
    if (emails.length === 0) continue;

    const parent = new Map<number, number>();
    for (let i = 0; i < emails.length; i++) parent.set(i, i);
    const find = (x: number): number => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    // 1) Склейка по Message-ID (In-Reply-To / References).
    const msgIndex = new Map<string, number>();
    emails.forEach((e, i) => {
      const norm = normalizeMessageId(e.messageId);
      if (norm && !msgIndex.has(norm)) msgIndex.set(norm, i);
    });
    emails.forEach((e, i) => {
      const candidates = [normalizeMessageId(e.inReplyTo ?? ""), ...(e.references ?? []).map(normalizeMessageId)];
      for (const c of candidates) {
        if (!c) continue;
        const j = msgIndex.get(c);
        if (j !== undefined) union(j, i);
      }
    });

    // 2) Фолбэк по нормализованной теме — только для ответов/пересылок,
    //    чтобы не склеивать одинаковые рассылки без reply-заголовков.
    const subjectThread = new Map<string, number>();
    emails.forEach((e, i) => {
      const norm = normalizeSubject(e.subject);
      if (!norm) return;
      const existing = subjectThread.get(norm);
      if (existing === undefined) {
        subjectThread.set(norm, i);
        return;
      }
      const replyish = !!e.inReplyTo || (e.references?.length ?? 0) > 0 || hasReplyPrefix(e.subject);
      if (replyish) union(existing, i);
    });

    // 3) Материализация групп в беседы.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < emails.length; i++) {
      const root = find(i);
      const arr = groups.get(root) ?? [];
      arr.push(i);
      groups.set(root, arr);
    }
    for (const idxs of groups.values()) {
      const first = emails[idxs[0]];
      const thread = createThread(acc, first.messageId, normalizeSubject(first.subject));
      let last = "";
      for (const i of idxs) {
        setEmailThread(emails[i].id, thread.id);
        const d = emails[i].date ?? emails[i].createdAt;
        if (d && d > last) last = d;
      }
      if (last) touchThread(thread.id, last);
      processed += idxs.length;
    }
  }
  return processed;
}

export interface ThreadGroup {
  id: string;
  subject: string;
  count: number;
  lastMessageAt: string | null;
  emails: EmailListItem[];
}

/**
 * Собирает письма в беседы (по threadId; одиночные письма — каждая беседа из одного).
 * Возвращает отсортированный по последнему сообщению список.
 *
 * Принимает тот же фильтр, что и список писем (поиск `q`, категории, даты и т.д.),
 * иначе поиск в режиме «Переписка» молча игнорировался.
 */
export function listThreadsGrouped(filter: EmailListFilter = {}): ThreadGroup[] {
  // 1) Фильтр (папка/поиск/категории) определяет, КАКИЕ беседы показать.
  const scope = listEmailsWithAnalysis(filter);
  if (!scope.length) return [];

  // 2) Внутри каждой беседы показываем ВСЕ письма, включая другие папки
  //    (ответы из «Отправленных» видны прямо в переписке «Входящих»).
  const threadIds = [...new Set(scope.map((e) => e.threadId).filter((x): x is string => !!x))];
  const full = listEmailsWithAnalysisByThreadIds(threadIds);

  const byThread = new Map<string, EmailListItem[]>();
  for (const e of scope) {
    if (!e.threadId) byThread.set("email:" + e.id, [e]);
  }
  for (const e of full) {
    const key = e.threadId ?? "email:" + e.id;
    const arr = byThread.get(key) ?? [];
    arr.push(e);
    byThread.set(key, arr);
  }

  const groups: ThreadGroup[] = [];
  for (const [key, list] of byThread) {
    list.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    const last = list[list.length - 1];
    groups.push({
      id: key,
      subject: baseSubject(list[0].subject),
      count: list.length,
      lastMessageAt: last?.date ?? null,
      emails: list
    });
  }
  groups.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  return groups;
}
