import nodemailer, { type Transporter } from "nodemailer";
import type { Account } from "../types.js";

export interface SmtpAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SmtpSendOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: SmtpAttachment[];
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

/** Оборачивает Message-ID в угловые скобки (для заголовков In-Reply-To / References). */
export function wrapMessageId(id: string): string {
  const bare = id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
  return "<" + bare + ">";
}

export function buildSmtpTransport(account: Account, password: string): Transporter {
  const host = account.smtpHost || account.host;
  const secure = (account.smtpTls ?? "starttls") === "ssl";
  const port = account.smtpPort ?? (secure ? 465 : 587);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: account.smtpUsername || account.username,
      pass: password
    },
    tls: { rejectUnauthorized: account.settings.rejectUnauthorized === true }
  });
}

/**
 * Отправляет письмо через SMTP и возвращает сырой MIME (для IMAP APPEND).
 * MIME собирается один раз через streamTransport, затем уходит через SMTP как raw.
 */
export async function sendSmtp(
  account: Account,
  password: string,
  opts: SmtpSendOptions
): Promise<{ messageId: string; raw: Buffer }> {
  const mail = {
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    messageId: opts.messageId
  };

  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const built = await builder.sendMail(mail);
  const raw = Buffer.isBuffer(built.message)
    ? built.message
    : Buffer.from(String(built.message ?? ""), "utf-8");

  const transport = buildSmtpTransport(account, password);
  try {
    // Отправляем теми же опциями (nodemailer сам соберёт envelope из to/cc/bcc),
    // а raw оставляем только для IMAP APPEND.
    const info = await transport.sendMail(mail);
    return { messageId: opts.messageId ?? info.messageId ?? "", raw };
  } finally {
    transport.close();
  }
}