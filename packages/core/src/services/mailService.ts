import { randomUUID } from "node:crypto";
import { getContext } from "../context.js";
import { logger } from "../logger.js";
import {
  emailExistsByMessageId,
  getAccount,
  insertAttachment,
  insertEmail,
  knownUidsForAccount
} from "../repos.js";
import { parseRawEmail, type ParsedEmail } from "../mail/parser.js";
import { splitMbox } from "../mail/mbox.js";
import { prepareAttachment } from "../attachments/index.js";
import { buildConnector, decryptPassword } from "./accountService.js";
import { getSettingValue } from "./settingsService.js";
import { enqueue } from "./analysisService.js";

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
  if (emailExistsByMessageId(parsed.messageId)) return false;

  const email = insertEmail({
    accountId,
    folder,
    uid,
    messageId: parsed.messageId,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    date: parsed.date,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    headers: parsed.headers
  });

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

  if (getSettingValue("auto_analyze", "true") === "true") {
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
  try {
    await connector.connect();
    const knownUids = knownUidsForAccount(accountId);
    const messages = await connector.fetchNew("INBOX", knownUids, { since, until });

    for (const raw of messages) {
      try {
        const parsed = await parseRawEmail(raw.source);
        if (!inDateRange(parsed.date, opts.since, opts.until)) {
          skipped++;
          continue;
        }
        if (await persistParsedEmail(accountId, "INBOX", raw.uid, parsed, ctx.config.dataDir)) {
          added++;
        } else {
          skipped++;
        }
      } catch (err) {
        logger.warn({ uid: raw.uid, err: (err as Error).message }, "Не удалось сохранить письмо");
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
    const buffers = /\.mbox$/i.test(f.filename) ? splitMbox(f.data) : [f.data];
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
