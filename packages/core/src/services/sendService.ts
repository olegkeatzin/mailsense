import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { getContext } from "../context.js";
import { getAccount, insertAttachment, insertEmail } from "../repos.js";
import { buildConnector, decryptPassword, decryptSmtpPassword } from "./accountService.js";
import { assignThread } from "./threadService.js";
import { buildSmtpTransport, sendSmtp, wrapMessageId } from "../mail/smtpSender.js";
import { classifyKind } from "../mail/parser.js";
import { saveAttachmentFile } from "../attachments/store.js";
import { DraftAttachmentError, readDraftAttachment } from "./draftService.js";
import type { Account, ComposeAttachment, ComposeInput, EmailAddress } from "../types.js";

export interface SendResult {
  emailId: string;
  messageId: string;
}

/**
 * Отказ по данным запроса на отправку (fromName/replyTo). Это 400-класс, а не сбой сервера:
 * такие поля нельзя «почистить молча» — человек увидит в письме не то, что написал.
 */
export class ComposeInputError extends Error {}

/** Предел длины имени в заголовке From (замороженный интерфейс). */
const FROM_NAME_MAX = 120;

/**
 * Имя работника для From. Пустая строка = поле не задано (работает прежний путь из настроек).
 * CR/LF, кавычки и обратный слэш ломают заголовок — отказ, а не тихая чистка.
 */
function readFromName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const name = raw.trim();
  if (!name) return "";
  if (name.length > FROM_NAME_MAX) {
    throw new ComposeInputError("Имя отправителя длиннее " + FROM_NAME_MAX + " символов");
  }
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new ComposeInputError("Имя отправителя содержит перевод строки или управляющий символ");
    }
    if (ch === '"' || ch === "\\") {
      throw new ComposeInputError("Имя отправителя содержит кавычку или обратный слэш — заголовок будет сломан");
    }
  }
  return name;
}

/** Адрес пригоден для заголовка: одна «собака», непустые части, домен с точкой, без пробелов и служебных знаков. */
function isValidAddress(value: string): boolean {
  if (!value || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return false;
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
    if (',;<>()[]"\\'.includes(ch)) return false;
  }
  return true;
}

/** Reply-To: пустая строка = не задано; иначе адрес обязан быть корректным. */
function readReplyTo(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  if (!isValidAddress(value)) {
    throw new ComposeInputError("Некорректный адрес для ответа (Reply-To): «" + value + "»");
  }
  return value;
}

function addressTo(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address;
}

function bareMessageId(id: string): string {
  return id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
}

/**
 * Содержимое вложения: данные из запроса либо файл черновика по ссылке.
 *
 * ⚠️ Если вложения нет — это ошибка, а не «письмо без файла»: человек видит вложение
 * в окне и уверен, что оно уйдёт. Поэтому содержимое собирается ДО отправки.
 */
function attachmentContent(att: ComposeAttachment): Buffer {
  if (typeof att.data === "string") return Buffer.from(att.data, "base64");
  if (att.ref && att.draftId) {
    const content = readDraftAttachment(att.draftId, att.ref);
    if (content) return content;
  }
  throw new DraftAttachmentError("Вложение «" + att.filename + "» не найдено — приложите файл заново");
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

  // Валидация заголовков — ДО любых сетевых операций и чтения вложений.
  const fromName = readFromName(compose.fromName);
  const replyTo = readReplyTo(compose.replyTo);

  const smtpPassword = decryptSmtpPassword(account);

  // Имя: сначала имя работника (Р18), иначе — отображаемое имя ящика (Thunderbird-подобно).
  // Адрес всегда адрес ящика аккаунта: подмена адреса запрещена.
  const displayName = typeof account.settings.displayName === "string" ? account.settings.displayName.trim() : "";
  const headerName = fromName || displayName;
  const fromHeader = headerName
    ? '"' + headerName.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" <' + account.username + ">"
    : account.username;

  const storedMessageId = randomUUID() + "@mailsense.local";
  const headerMessageId = wrapMessageId(storedMessageId);
  const inReplyTo = compose.inReplyToMessageId ? wrapMessageId(compose.inReplyToMessageId) : undefined;
  const references =
    compose.references && compose.references.length
      ? compose.references.map((r) => wrapMessageId(r)).join(" ")
      : undefined;

  // Вложения читаем заранее: письмо не должно уйти без файла, который человек видит.
  const outgoing = (compose.attachments ?? []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    content: attachmentContent(a)
  }));

  const { raw } = await sendSmtp(account, smtpPassword, {
    from: fromHeader,
    to: compose.to.map(addressTo),
    cc: compose.cc?.map(addressTo),
    bcc: compose.bcc?.map(addressTo),
    subject: compose.subject,
    text: compose.bodyText,
    html: compose.bodyHtml || undefined,
    attachments: outgoing.map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: a.content
    })),
    inReplyTo,
    references,
    messageId: headerMessageId,
    replyTo: replyTo || undefined
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

  // ⚠️ Копия в «Отправленных» должна показывать то, что реально ушло. Раньше строк
  // вложений у неё не было вообще: открыв отправленное письмо, человек не видел файлов,
  // которые ушли адресату. Файл уже есть в памяти — кладём его на диск, как во входящих.
  // OCR не зовём: отправителю незачем извлекать текст из собственного вложения.
  for (const att of outgoing) {
    try {
      const content = att.content;
      // Имена вложений не уникальны (два «акт.pdf» в одном письме) — saveAttachmentFile
      // подбирает свободное имя и никогда не перезаписывает существующий файл.
      const storagePath = saveAttachmentFile(getContext().config.dataDir, email.id, att.filename, content);
      insertAttachment({
        emailId: email.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: content.length,
        storagePath,
        extractedText: null,
        contentId: null,
        kind: classifyKind(att.mimeType, att.filename),
        handled: true
      });
    } catch (err) {
      // Письмо адресату уже ушло: сбой записи копии не должен выглядеть как неудачная
      // отправка. Но и молчать нельзя — вложение пропадёт из «Отправленных».
      logger.warn(
        { emailId: email.id, filename: att.filename, err: (err as Error).message },
        "Вложение не сохранено в копии «Отправленных»"
      );
    }
  }

  try {
    assignThread(email);
  } catch (err) {
    logger.warn({ emailId: email.id, err: (err as Error).message }, "Не удалось привязать беседу (отправка)");
  }

  // Письмо получателю уже ушло. Сбой дописывания копии в «Отправленные» —
  // это не неудачная отправка, и показывать пользователю ошибку нельзя.
  try {
    await appendToSent(account, raw);
  } catch (err) {
    logger.warn({ emailId: email.id, err: (err as Error).message }, "Копия не дописана в «Отправленные»");
  }

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