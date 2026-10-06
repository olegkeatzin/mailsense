import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { getContext } from "../context.js";
import { deleteDraft, getDraft, insertDraft, listAttachments, updateDraft } from "../repos.js";
import { saveFileIn } from "../attachments/store.js";
import type { Draft, DraftAttachment, EmailAddress } from "../types.js";

/**
 * Черновики с вложениями: содержимое лежит ФАЙЛАМИ, а не base64 в JSON.
 *
 * ⚠️ Раньше вложение целиком лежало в drafts.attachments (base64), и автосохранение
 * каждые 15 секунд отправляло эти мегабайты заново — по сети и в памяти. Теперь данные
 * раскладываются в <dataDir>/drafts/<draftId>/<файл> ОДИН раз, а в JSON остаётся ссылка:
 * последующие сохранения несут только ссылки.
 *
 * ⚠️ Ссылку из запроса нельзя «расширять» до произвольного пути: и на чтение, и на отдачу
 * файл обязан быть в списке вложений этого черновика, а ссылка — именем файла в его
 * каталоге (ни слэшей, ни «..»).
 */

/**
 * Вложение не удалось разложить в файл: битая ссылка, нет файла в письме, нет ни данных,
 * ни ссылки. Это ошибка данных запроса, а не сбой сервера — наружу её отдают как 400.
 */
export class DraftAttachmentError extends Error {}

/** Что приходит из интерфейса: данные свежего файла, ссылка на файл черновика или вложение письма. */
export interface DraftAttachmentInput {
  filename: string;
  mimeType: string;
  size?: number;
  data?: string;
  ref?: string;
  /** Вложение письма (пересылка): сервер копирует файл сам, без base64 по сети. */
  emailRef?: { emailId: string; attachmentId: string };
}

export interface DraftInput {
  accountId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: DraftAttachmentInput[];
  inReplyToEmailId?: string | null;
  inReplyToMessageId?: string | null;
  references?: string[];
}

/** Каталог файлов черновика. */
export function draftDir(draftId: string): string {
  return path.join(getContext().config.dataDir, "drafts", draftId);
}

/** Ссылка — имя файла внутри каталога черновика: без слэшей и без «..». */
function isPlainRef(ref: string): boolean {
  return !!ref && path.basename(ref) === ref && ref !== "." && ref !== "..";
}

/**
 * Раскладывает данные вложений в файлы черновика. Уже разложенные ссылки не трогаем:
 * иначе автосохранение перезаписывало бы файлы и плодило копии.
 */
function layoutAttachments(draftId: string, list: DraftAttachmentInput[]): DraftAttachment[] {
  const dir = draftDir(draftId);
  return list.map((att) => {
    let ref = typeof att.ref === "string" && att.ref ? att.ref : undefined;
    if (ref && !isPlainRef(ref)) {
      throw new DraftAttachmentError("Некорректная ссылка на файл вложения: " + att.filename);
    }

    let size = typeof att.size === "number" && att.size > 0 ? att.size : 0;
    if (!ref && typeof att.data === "string") {
      const content = Buffer.from(att.data, "base64");
      ref = path.basename(saveFileIn(dir, att.filename, content));
      size = content.length;
    } else if (!ref && att.emailRef) {
      // Файл письма копируем на сервере: base64 через сеть не гоняем даже один раз.
      const source = listAttachments(att.emailRef.emailId).find((a) => a.id === att.emailRef?.attachmentId);
      if (!source?.storagePath || !fs.existsSync(source.storagePath)) {
        // Молча положить вложение «без файла» нельзя: человек видит его в окне.
        throw new DraftAttachmentError("Вложение «" + att.filename + "» не найдено в письме — приложите файл заново");
      }
      const content = fs.readFileSync(source.storagePath);
      ref = path.basename(saveFileIn(dir, att.filename, content));
      size = content.length;
    }
    if (!ref) {
      throw new DraftAttachmentError("Вложение «" + att.filename + "» без данных и без ссылки");
    }
    if (!size) {
      try {
        size = fs.statSync(path.join(dir, ref)).size;
      } catch {
        // Файла нет — размер останется нулевым, а чтение при отправке скажет об этом громко.
        logger.warn({ draftId, ref }, "Файл вложения черновика не найден");
      }
    }
    return { filename: att.filename, mimeType: att.mimeType, size, ref };
  });
}

/** Создаёт черновик, раскладывая вложения в файлы. */
export function createDraft(input: DraftInput): Draft {
  // Идентификатор нужен заранее: файлы вложений лежат в каталоге черновика.
  const id = randomUUID();
  const attachments = layoutAttachments(id, input.attachments ?? []);
  try {
    return insertDraft({ ...input, id, attachments });
  } catch (err) {
    // Черновик не создан — файлы ему больше не нужны.
    removeDraftFiles(id);
    throw err;
  }
}

/** Сохраняет черновик (в том числе автосохранение): ссылки остаются ссылками. */
export function saveDraft(id: string, patch: Partial<Omit<DraftInput, "accountId">>): Draft | null {
  const existing = getDraft(id);
  if (!existing) return null;
  // Вложения обрабатываем отдельно: на входе они могут быть с данными (DraftAttachmentInput),
  // а в базе лежат уже разложенными (DraftAttachment).
  const { attachments: incoming, ...fields } = patch;
  if (incoming === undefined) return updateDraft(id, fields);

  const attachments = layoutAttachments(id, incoming);
  const saved = updateDraft(id, { ...fields, attachments });
  // Вложение убрали из окна — его файл больше не нужен: иначе 20 МБ останутся
  // на диске до удаления черновика.
  dropUnusedFiles(id, attachments.map((a) => a.ref as string));
  return saved;
}

/** Удаляет из каталога черновика файлы, на которые больше никто не ссылается. */
function dropUnusedFiles(draftId: string, keep: string[]): void {
  const dir = draftDir(draftId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const alive = new Set(keep);
  for (const name of names) {
    if (alive.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      logger.warn({ draftId, name, err: (err as Error).message }, "Не удалось удалить файл вложения черновика");
    }
  }
}

/** Удаляет черновик вместе с его файлами. */
export function removeDraft(id: string): void {
  deleteDraft(id);
  removeDraftFiles(id);
}

function removeDraftFiles(id: string): void {
  try {
    fs.rmSync(draftDir(id), { recursive: true, force: true });
  } catch (err) {
    logger.warn({ draftId: id, err: (err as Error).message }, "Не удалось удалить файлы черновика");
  }
}

/** Вложение черновика по ссылке: null, если файла нет или он не из этого черновика. */
function findDraftAttachment(draftId: string, ref: string): DraftAttachment | null {
  if (!isPlainRef(ref)) return null;
  const draft = getDraft(draftId);
  if (!draft) return null;
  const att = draft.attachments.find((a) => a.ref === ref);
  if (!att) return null;
  return fs.existsSync(path.join(draftDir(draftId), ref)) ? att : null;
}

/** Есть ли файл вложения в этом черновике (без чтения содержимого). */
export function hasDraftAttachment(draftId: string, ref: string): boolean {
  return findDraftAttachment(draftId, ref) !== null;
}

/** Читает содержимое вложения черновика. null — файла нет или ссылка чужая. */
export function readDraftAttachment(draftId: string, ref: string): Buffer | null {
  const att = findDraftAttachment(draftId, ref);
  if (!att) return null;
  return fs.readFileSync(path.join(draftDir(draftId), ref));
}

/** Абсолютный путь к файлу вложения черновика (для отдачи по HTTP). */
export function draftAttachmentFile(draftId: string, ref: string): string | null {
  return findDraftAttachment(draftId, ref) ? path.join(draftDir(draftId), ref) : null;
}