import MsgReaderImport from "@kenjiuno/msgreader";
import type { EmailAddress } from "../types.js";
import { normalizeMessageId } from "./parser.js";
import type { ParsedEmail, ParsedAttachment } from "./parser.js";

interface MsgReaderLike {
  getFileData(): {
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    senderSmtpAddress?: string;
    body?: string;
    bodyHtml?: string;
    messageId?: string;
    clientSubmitTime?: string;
    messageDeliveryTime?: string;
    creationTime?: string;
    recipients?: { name?: string; email?: string; smtpAddress?: string; recipType?: string }[];
    attachments?: { fileName?: string; attachMimeTag?: string; pidContentId?: string | null }[];
  };
  getAttachment(a: unknown): { fileName: string; content: Uint8Array };
}

function resolveMsgReaderCtor(): new (ab: ArrayBuffer) => MsgReaderLike {
  const m = MsgReaderImport as unknown as Record<string, unknown>;
  const cands = [m, m.default, (m.default as Record<string, unknown> | undefined)?.default, m.MsgReader];
  for (const c of cands) {
    if (typeof c === "function") return c as new (ab: ArrayBuffer) => MsgReaderLike;
  }
  throw new Error("Не удалось загрузить MsgReader");
}

function toIso(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Парсит Outlook .msg (OLE2) в общий формат ParsedEmail.
 * Использует @kenjiuno/msgreader (синхронный API).
 */
export function parseMsg(source: Buffer): ParsedEmail {
  const ab = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const Reader = resolveMsgReaderCtor();
  const reader = new Reader(ab);
  const d = reader.getFileData();

  const recipients = d.recipients ?? [];
  const addr = (r: { name?: string; email?: string; smtpAddress?: string }): EmailAddress => ({
    name: r.name || undefined,
    address: r.email || r.smtpAddress || ""
  });
  const to = recipients.filter((r) => r.recipType === "to").map(addr);
  const cc = recipients.filter((r) => r.recipType === "cc").map(addr);

  const fromAddr = d.senderEmail || d.senderSmtpAddress || "";
  const from: EmailAddress | null = fromAddr ? { name: d.senderName || undefined, address: fromAddr } : null;

  const attachments: ParsedAttachment[] = (d.attachments ?? []).map((a) => {
    const att = reader.getAttachment(a);
    return {
      filename: att.fileName || a.fileName || "attachment",
      mimeType: a.attachMimeTag || "application/octet-stream",
      size: att.content.byteLength,
      content: Buffer.from(att.content),
      contentId: a.pidContentId ?? null
    };
  });

  return {
    messageId: normalizeMessageId(d.messageId ?? ""),
    subject: d.subject ?? "(без темы)",
    from,
    to,
    cc,
    replyTo: [],
    inReplyTo: null,
    references: [],
    date: toIso(d.clientSubmitTime ?? d.messageDeliveryTime ?? d.creationTime),
    bodyText: d.body ?? "",
    bodyHtml: d.bodyHtml ?? null,
    headers: {},
    attachments
  };
}