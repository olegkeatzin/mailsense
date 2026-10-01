import { randomUUID } from "node:crypto";
import { getContext } from "../context.js";
import { logger } from "../logger.js";
import {
  clearDeletedEmail,
  emailExistsByMessageId,
  getAccount,
  insertAttachment,
  insertEmail,
  knownUidsForAccount,
  patchAccountSettings
} from "../repos.js";
import { parseRawEmail, type ParsedEmail } from "../mail/parser.js";
import { parseMsg } from "../mail/msg.js";
import { isMboxData, splitMbox } from "../mail/mbox.js";
import { prepareAttachment } from "../attachments/index.js";
import { buildConnector, decryptPassword } from "./accountService.js";
import { getSettingValue } from "./settingsService.js";
import { enqueue } from "./analysisService.js";
import { assignThread } from "./threadService.js";
import type { Account } from "../types.js";
import type { MailConnector } from "../mail/connector.js";

export interface FetchResult {
  added: number;
  skipped: number;
}

export interface FetchEmailsOptions {
  since?: string; // ISO "YYYY-MM-DD"
  until?: string; // ISO "YYYY-MM-DD"
  /**
   * Игнорировать надгробия удалённых писем (ручной скан): письмо, удалённое
   * в приложении, но оставшееся на сервере, будет скачано заново.
   */
  includeDeleted?: boolean;
}

export interface ImportFile {
  filename: string;
  data: Buffer;
}

// Общий шаг: сохранить распарсенное письмо (дедупликация + вложения + автоанализ).
async function persistParsedEmail(
  accountId: string,
  folder: string,
  uid: string,
  parsed: ParsedEmail,
  dataDir: string,
  includeDeleted = false
): Promise<boolean> {
  // Письма без Message-ID получают синтетический уникальный ID (иначе UNIQUE-констрейнт их роняет).
  const messageId = parsed.messageId || `${accountId}:${folder}:${uid}:${parsed.subject}`;
  if (emailExistsByMessageId(messageId, includeDeleted)) return false;

  const email = insertEmail({
    accountId,
    folder,
    uid,
    messageId,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    replyTo: parsed.replyTo,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    date: parsed.date,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    headers: parsed.headers
  });

  try {
    assignThread(email);
  } catch (err) {
    logger.warn({ emailId: email.id, err: (err as Error).message }, "Не удалось привязать беседу");
  }

  for (const att of parsed.attachments) {
    const prep = await prepareAttachment(dataDir, email.id, att.filename, att.mimeType, att.content);
    insertAttachment({
      emailId: email.id,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      storagePath: prep.storagePath,
      extractedText: prep.extractedText,
      contentId: att.contentId,
      kind: prep.kind,
      handled: prep.handled
    });
  }

  // Письмо снова сохранено из ящика — надгробие удаления больше не нужно,
  // иначе оно будет вечно блокировать повторный скан.
  if (includeDeleted) clearDeletedEmail(accountId, folder, uid, messageId);

  // Все письма (включая ответы внутри переписки) проходят обычный путь анализа.
  // Раньше ответы помечались «Готово» без анализа — это давало ложный статус в UI.
  if (getSettingValue("auto_analyze", "true") === "true") {
    enqueue(email.id);
  }
  return true;
}

/** Фильтр по дате получения в локальном часовом поясе (сравниваем моменты времени, а не строки UTC). */
function inDateRange(date: string | null, since?: string, until?: string): boolean {
  if (!date) return true;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return true;
  if (since) {
    const start = new Date(since + "T00:00:00").getTime();
    if (!Number.isNaN(start) && t < start) return false;
  }
  if (until) {
    const end = new Date(until + "T23:59:59.999").getTime();
    if (!Number.isNaN(end) && t > end) return false;
  }
  return true;
}

const SENT_NAMES = ["sent", "sent items", "sent messages", "отправленные", "inbox.sent"];

/** Определяет имя IMAP-папки «Отправленные» (override → SPECIAL-USE \Sent → имя). */
async function detectSentFolder(connector: MailConnector, account: Account): Promise<string | null> {
  const override = (account.settings.sentFolder as string) || null;
  if (override) return override;
  const boxes = await connector.listMailboxes?.();
  if (!boxes) return null;
  const byUse = boxes.find((b) => b.specialUse && b.specialUse.toLowerCase().includes("\\sent"));
  if (byUse) return byUse.path;
  const byName = boxes.find(
    (b) => SENT_NAMES.includes(b.name.toLowerCase()) || SENT_NAMES.includes(b.path.toLowerCase())
  );
  return byName?.path ?? null;
}

async function doFetchEmails(accountId: string, opts: FetchEmailsOptions = {}): Promise<FetchResult> {
  const ctx = getContext();
  const account = getAccount(accountId);
  if (!account) throw new Error("Аккаунт не найден");

  const password = decryptPassword(account);
  const connector = buildConnector(account, password);

  const since = opts.since ? new Date(opts.since + "T00:00:00") : undefined;
  const until = opts.until ? new Date(opts.until + "T23:59:59") : undefined;

  let added = 0;
  let skipped = 0;

  const includeDeleted = opts.includeDeleted === true;

  const processFolder = async (imapFolder: string, storeFolder: string): Promise<void> => {
    // Ручной скан не считает удалённые письма известными — иначе их не вернуть.
    const knownUids = knownUidsForAccount(accountId, storeFolder, includeDeleted);
    // POP3-коннектор серверного поиска по датам не имеет — отдаём как есть,
    // а диапазон применяем клиентски по разобранной дате письма.
    const messages = await connector.fetchNew(imapFolder, knownUids, { since, until });
    for (const raw of messages) {
      try {
        const parsed = await parseRawEmail(raw.source);
        if (!inDateRange(parsed.date, opts.since, opts.until)) {
          skipped++;
          continue;
        }
        if (
          await persistParsedEmail(accountId, storeFolder, raw.uid, parsed, ctx.config.dataDir, includeDeleted)
        ) {
          added++;
        } else {
          skipped++;
        }
      } catch (err) {
        logger.warn({ folder: imapFolder, uid: raw.uid, err: (err as Error).message }, "Не удалось сохранить письмо");
      }
    }
  };

  try {
    await connector.connect();
    await processFolder("INBOX", "INBOX");

    if (account.protocol === "imap") {
      const sent = await detectSentFolder(connector, account);
      if (sent && sent.toLowerCase() !== "inbox") {
        try {
          await processFolder(sent, "Sent");
        } catch (err) {
          logger.warn({ sent, err: (err as Error).message }, "Не удалось синхронизировать Sent");
        }
      }
    }
  } finally {
    await connector.disconnect();
  }

  // Отметка времени последней синхронизации: планировщик использует её,
  // чтобы не сканировать весь ящик при каждом запуске (см. scheduler.ts).
  patchAccountSettings(accountId, { lastFetchAt: new Date().toISOString() });

  return { added, skipped };
}

// Один аккаунт обслуживается одним соединением за раз: параллельные сканы
// (планировщик + кнопка «Скан») приводили к «Connection not available» и таймаутам.
const inFlightFetches = new Map<string, Promise<FetchResult>>();

export function isFetching(accountId: string): boolean {
  return inFlightFetches.has(accountId);
}

export function fetchEmails(accountId: string, opts: FetchEmailsOptions = {}): Promise<FetchResult> {
  const prev = inFlightFetches.get(accountId);
  const run: Promise<FetchResult> = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
    doFetchEmails(accountId, opts)
  );
  inFlightFetches.set(accountId, run);
  return run.finally(() => {
    if (inFlightFetches.get(accountId) === run) inFlightFetches.delete(accountId);
  });
}

export async function importEmails(
  accountId: string,
  folder: string,
  files: ImportFile[]
): Promise<FetchResult> {
  const ctx = getContext();
  let added = 0;
  let skipped = 0;

  for (const f of files) {
    if (/\.msg$/i.test(f.filename)) {
      try {
        const parsed = parseMsg(f.data);
        const saved = await persistParsedEmail(accountId, folder, "import:" + randomUUID(), parsed, ctx.config.dataDir);
        if (saved) added++;
        else skipped++;
      } catch (err) {
        logger.warn({ file: f.filename, err: (err as Error).message }, "Ошибка импорта .msg");
      }
      continue;
    }
    const buffers = /\.mbox$/i.test(f.filename) || isMboxData(f.data) ? splitMbox(f.data) : [f.data];
    for (const buf of buffers) {
      try {
        const parsed = await parseRawEmail(buf);
        const saved = await persistParsedEmail(accountId, folder, "import:" + randomUUID(), parsed, ctx.config.dataDir);
        if (saved) added++;
        else skipped++;
      } catch (err) {
        logger.warn({ file: f.filename, err: (err as Error).message }, "Ошибка импорта письма");
      }
    }
  }

  return { added, skipped };
}
