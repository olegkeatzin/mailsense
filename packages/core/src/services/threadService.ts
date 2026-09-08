import {
  createThread,
  findEmailByMessageId,
  listEmailsWithAnalysis,
  setEmailThread,
  touchThread,
  type EmailListItem
} from "../repos.js";
import type { Email } from "../types.js";

/** Базовая тема: срезает Re:/Fwd:/Ответ: без приведения регистра. */
export function baseSubject(subject: string): string {
  return subject.replace(/^\s*(re|fw|fwd|aw|ответ|переслано)\s*:\s*/i, "").trim() || subject;
}

/** Нормализация темы: срезает Re:/Fwd:/Ответ: и приводит к нижнему регистру. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fw|fwd|aw|sv|ответ|переслано|відповідь)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Привязывает письмо к беседе. Приоритет — точный матч In-Reply-To / References
 * на существующие Message-ID; если родителя нет в БД — создаём новую беседу.
 */
export function assignThread(email: Email): string {
  const accountId = email.accountId;
  const candidateIds = [email.inReplyTo, ...email.references].filter(
    (x): x is string => !!x
  );

  for (const mid of candidateIds) {
    const parent = findEmailByMessageId(accountId, mid);
    if (parent) {
      const threadId = parent.threadId ?? ensureThreadFor(parent);
      if (email.threadId !== threadId) setEmailThread(email.id, threadId);
      touchThread(threadId, email.date ?? email.createdAt);
      return threadId;
    }
  }

  const thread = createThread(accountId, email.messageId, normalizeSubject(email.subject));
  setEmailThread(email.id, thread.id);
  return thread.id;
}

function ensureThreadFor(email: Email): string {
  const thread = createThread(email.accountId, email.messageId, normalizeSubject(email.subject));
  setEmailThread(email.id, thread.id);
  return thread.id;
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
 */
export function listThreadsGrouped(accountId?: string, folder?: string): ThreadGroup[] {
  const emails = listEmailsWithAnalysis({ accountId, folder });
  const byThread = new Map<string, EmailListItem[]>();
  for (const e of emails) {
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