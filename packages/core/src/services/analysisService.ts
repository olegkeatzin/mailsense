import fs from "node:fs";
import { getContext } from "../context.js";
import { logger } from "../logger.js";
import {
  getEmail,
  listAttachments,
  listEmails,
  setAttachmentDescription,
  setEmailFolder,
  setEmailStatus,
  upsertAnalysis
} from "../repos.js";
import { prepareAttachment, type PreparedAttachment } from "../attachments/index.js";
import { analyzeEmailRaw } from "../ai/analyze.js";
import { parseAnalysis } from "../ai/parse.js";
import { analysisQueue } from "../analysis/queue.js";
import { getAiConfig } from "./settingsService.js";
import type { AnalysisResult } from "../types.js";

const inFlight = new Set<string>();
let currentAbort: AbortController | null = null;

export function enqueue(emailId: string): void {
  if (inFlight.has(emailId)) return;
  inFlight.add(emailId);
  setEmailStatus(emailId, "queued");
  analysisQueue
    .add(() => runAnalysis(emailId))
    .catch(() => {
      /* обработано внутри runAnalysis */
    })
    .finally(() => inFlight.delete(emailId));
}

export async function runAnalysis(emailId: string): Promise<AnalysisResult | null> {
  const email = getEmail(emailId);
  if (!email) {
    logger.warn({ emailId }, "Письмо удалено — анализ пропущен");
    return null;
  }
  setEmailStatus(emailId, "processing");
  const ac = new AbortController();
  currentAbort = ac;
  try {
    const ctx = getContext();

    const prepared: PreparedAttachment[] = [];
    for (const att of listAttachments(emailId)) {
      if (!att.storagePath || !fs.existsSync(att.storagePath)) continue;
      try {
        const buf = fs.readFileSync(att.storagePath);
        prepared.push(
          await prepareAttachment(ctx.config.dataDir, emailId, att.filename, att.mimeType, buf)
        );
      } catch (err) {
        logger.warn({ att: att.filename, err: (err as Error).message }, "Ошибка подготовки вложения");
      }
    }

    const attachmentTexts = prepared
      .filter((p) => p.extractedText)
      .map((p) => p.extractedText as string);
    const images = prepared.flatMap((p) => p.images);
    const notes = prepared
      .filter((p) => !p.handled)
      .map((p) => p.filename + ": " + (p.note ?? "не обработано"));

    const from = email.from
      ? email.from.name
        ? email.from.name + " <" + email.from.address + ">"
        : email.from.address
      : "";

    const raw = await analyzeEmailRaw(
      getAiConfig(),
      {
        subject: email.subject,
        from,
        date: email.date,
        bodyText: email.bodyText,
        attachmentTexts,
        attachmentNotes: notes,
        images,
        attachmentNames: listAttachments(emailId).map((a) => a.filename)
      },
      ac.signal
    );

    if (ac.signal.aborted) {
      setEmailStatus(emailId, "pending");
      return null;
    }
    if (!getEmail(emailId)) {
      logger.warn({ emailId }, "Письмо удалено во время анализа — результат отброшен");
      return null;
    }

    const parsed = parseAnalysis(raw);
    const model = getAiConfig().model;

    const result = upsertAnalysis({
      emailId,
      summary: parsed.summary,
      tags: parsed.tags,
      priority: parsed.priority,
      urgent: parsed.urgent,
      eventDate: parsed.event_date ?? null,
      category: parsed.category,
      rawResponse: raw,
      modelUsed: model,
      attachments: parsed.attachments
    });

    for (const d of parsed.attachments) {
      const att = listAttachments(emailId).find((x) => x.filename === d.name);
      if (att) setAttachmentDescription(att.id, d.description);
    }

    if (parsed.category === "spam") {
      setEmailFolder(emailId, "SPAM");
    }

    setEmailStatus(emailId, "ready");
    logger.info({ emailId }, "Анализ завершён");
    return result;
  } catch (err) {
    if (ac.signal.aborted) {
      logger.info({ emailId }, "Анализ остановлен пользователем");
      setEmailStatus(emailId, "pending");
      return null;
    }
    logger.error({ emailId, err: (err as Error).message }, "Ошибка анализа");
    setEmailStatus(emailId, "error");
    return null;
  } finally {
    if (currentAbort === ac) currentAbort = null;
  }
}

export function analyzeAllPending(): number {
  const emails = listEmails();
  let n = 0;
  for (const e of emails) {
    if (e.analysisStatus !== "ready") {
      enqueue(e.id);
      n++;
    }
  }
  return n;
}

export async function analyzeEmail(emailId: string): Promise<void> {
  enqueue(emailId);
}

export function analyzeEmails(emailIds: string[]): number {
  let n = 0;
  for (const id of emailIds) {
    enqueue(id);
    n++;
  }
  return n;
}

export function queueLength(): number {
  return analysisQueue.size + analysisQueue.pending;
}

/** Останавливает анализ: очищает очередь, сбрасывает «queued» → «pending» и прерывает текущий запрос. */
export function stopAnalysis(): number {
  let cleared = 0;
  for (const e of listEmails()) {
    if (e.analysisStatus === "queued") {
      setEmailStatus(e.id, "pending");
      inFlight.delete(e.id);
      cleared++;
    }
  }
  analysisQueue.clear();
  if (currentAbort) currentAbort.abort();
  return cleared;
}

/** Снимает письма с учёта «в работе» (вызывается при удалении писем). */
export function cancelAnalysis(ids: string[]): void {
  for (const id of ids) inFlight.delete(id);
}

export function analyzeRange(since?: string, until?: string, accountIds?: string[]): number {
  let emails = listEmails();
  if (accountIds && accountIds.length > 0) {
    const set = new Set(accountIds);
    emails = emails.filter((e) => set.has(e.accountId));
  }
  let n = 0;
  for (const e of emails) {
    const d = e.date ? e.date.slice(0, 10) : "";
    if (since && d < since) continue;
    if (until && d > until) continue;
    enqueue(e.id);
    n++;
  }
  return n;
}
