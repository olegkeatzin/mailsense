import { randomUUID } from "node:crypto";
import { getContext } from "../context.js";
import { logger } from "../logger.js";
import {
  emailExistsByMessageId,
  findEmailByMessageId,
  getAccount,
  insertAttachment,
  insertEmail,
  knownUidsForAccount,
  setEmailStatus
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
  dataDir: string
): Promise<boolean> {
  // Письма без Message-ID получают синтетический уникальный ID (иначе UNIQUE-констрейнт их роняет).
  const messageId = parsed.messageId || `${accountId}:${folder}:${uid}:${parsed.subject}`;
  if (emailExistsByMessageId(messageId)) return false;

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

  // Ответы/пересылки внутри существующей переписки не анализируем заново —
  // они помечаются готовыми и не попадают в очередь OCR/сводки.
  const isContinuation = [email.inReplyTo, ...email.references].some(
    (mid) => !!mid && !!findEmailByMessageId(accountId, mid)
  );
  if (isContinuation) {
    setEmailStatus(email.id, "ready");
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

  if (!isContinuation && getSettingValue("auto_analyze", "true") === "true") {
    enqueue(email.id);
  }
  return true;
}

function inDateRange(date: string | null, since?: string, until?: string): boolean {
  if (!date) return true;
  const d = date.slice(0, 10); // YYYY-MM-DD
  if (since && d < since) return false;
  if (until && d > until) return false;
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

export async function fetchEmails(accountId: string, opts: FetchEmailsOptions = {}): Promise<FetchResult> {
  const ctx = getContext();
  const account = getAccount(accountId);
  if (!account) throw new Error("Аккаунт не найден");

  const password = decryptPassword(account);
  const connector = buildConnector(account, password);

  const since = opts.since ? new Date(opts.since + "T00:00:00") : undefined;
  const until = opts.until ? new Date(opts.until + "T23:59:59") : undefined;

  let added = 0;
  let skipped = 0;

  const processFolder = async (imapFolder: string, storeFolder: string): Promise<void> => {
    const knownUids = knownUidsForAccount(accountId, storeFolder);
    const messages = await connector.fetchNew(imapFolder, knownUids, { since, until });
    for (const raw of messages) {
      try {
        const parsed = await parseRawEmail(raw.source);
        if (!inDateRange(parsed.date, opts.since, opts.until)) {
          skipped++;
          continue;
        }
        if (await persistParsedEmail(accountId, storeFolder, raw.uid, parsed, ctx.config.dataDir)) {
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

  return { added, skipped };
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
