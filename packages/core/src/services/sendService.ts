import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { getAccount, insertEmail } from "../repos.js";
import { buildConnector, decryptPassword, decryptSmtpPassword } from "./accountService.js";
import { assignThread } from "./threadService.js";
import { buildSmtpTransport, sendSmtp, wrapMessageId } from "../mail/smtpSender.js";
import type { Account, ComposeInput, EmailAddress } from "../types.js";

export interface SendResult {
  emailId: string;
  messageId: string;
}

function addressTo(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address;
}

function bareMessageId(id: string): string {
  return id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
}

async function appendToSent(account: Account, raw: Buffer): Promise<void> {
  if (account.protocol !== "imap") return;
  const sentFolder = (account.settings.sentFolder as string) || "Sent";
  const password = decryptPassword(account);
  const connector = buildConnector(account, password);
  try {
    await connector.connect();
    await connector.appendRaw?.(sentFolder, raw, ["\\Seen"]);
  } finally {
    await connector.disconnect();
  }
}

export async function sendEmail(compose: ComposeInput): Promise<SendResult> {
  const account = getAccount(compose.accountId);
  if (!account) throw new Error("Аккаунт не найден");
  if (!compose.to || compose.to.length === 0) throw new Error("Укажите получателя");

  const smtpPassword = decryptSmtpPassword(account);

  const storedMessageId = randomUUID() + "@mailsense.local";
  const headerMessageId = wrapMessageId(storedMessageId);
  const inReplyTo = compose.inReplyToMessageId ? wrapMessageId(compose.inReplyToMessageId) : undefined;
  const references =
    compose.references && compose.references.length
      ? compose.references.map((r) => wrapMessageId(r)).join(" ")
      : undefined;

  const { raw } = await sendSmtp(account, smtpPassword, {
    from: account.username,
    to: compose.to.map(addressTo),
    cc: compose.cc?.map(addressTo),
    bcc: compose.bcc?.map(addressTo),
    subject: compose.subject,
    text: compose.bodyText,
    html: compose.bodyHtml || undefined,
    attachments: (compose.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: Buffer.from(a.data, "base64")
    })),
    inReplyTo,
    references,
    messageId: headerMessageId
  });

  const email = insertEmail({
    accountId: account.id,
    folder: "Sent",
    uid: "sent:" + randomUUID(),
    messageId: storedMessageId,
    subject: compose.subject,
    from: { address: account.username },
    to: compose.to,
    cc: compose.cc ?? [],
    replyTo: [],
    inReplyTo: compose.inReplyToMessageId ? bareMessageId(compose.inReplyToMessageId) : null,
    references: compose.references ?? [],
    date: new Date().toISOString(),
    bodyText: compose.bodyText,
    bodyHtml: compose.bodyHtml ?? null,
    headers: {},
    analysisStatus: "ready"
  });

  try {
    assignThread(email);
  } catch (err) {
    logger.warn({ emailId: email.id, err: (err as Error).message }, "Не удалось привязать беседу (отправка)");
  }

  await appendToSent(account, raw);

  return { emailId: email.id, messageId: storedMessageId };
}

export async function testSmtpConnection(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: "Аккаунт не найден" };
  if (!account.smtpHost && !account.host) return { ok: false, error: "SMTP-сервер не задан" };
  const transport = buildSmtpTransport(account, decryptSmtpPassword(account));
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    transport.close();
  }
}