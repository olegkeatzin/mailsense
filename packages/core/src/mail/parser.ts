import {
  simpleParser,
  type ParsedMail,
  type AddressObject,
  type Headers
} from "mailparser";
import type { EmailAddress, AttachmentKind } from "../types.js";

export interface ParsedEmail {
  messageId: string;
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  date: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, string | string[] | undefined>;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Buffer;
  contentId: string | null;
}

function toEmailAddress(v: { name?: string; address?: string }): EmailAddress {
  return { name: v.name || undefined, address: v.address ?? "" };
}

function firstAddress(addr: AddressObject | AddressObject[] | undefined): EmailAddress | null {
  if (!addr) return null;
  const obj = Array.isArray(addr) ? addr[0] : addr;
  if (!obj || !obj.value || !obj.value[0]) return null;
  return toEmailAddress(obj.value[0]);
}

function allAddresses(addr: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.flatMap((a) => (a.value ?? []).map(toEmailAddress));
}

function headersToObj(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of headers) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.map((x) => String(x));
    else if (v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

export async function parseRawEmail(source: Buffer): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(source, { skipHtmlToText: false });

  const subject = parsed.subject ?? "(без темы)";
  const hdrId = parsed.headers?.get("message-id");
  const messageId = parsed.messageId ?? (typeof hdrId === "string" ? hdrId : "");

  return {
    messageId,
    subject,
    from: firstAddress(parsed.from),
    to: allAddresses(parsed.to),
    date: parsed.date ? parsed.date.toISOString() : null,
    bodyText: (parsed.text ?? "").trim(),
    bodyHtml: parsed.html || null,
    headers: parsed.headers ? headersToObj(parsed.headers) : {},
    attachments: (parsed.attachments ?? []).map((att) => ({
      filename: att.filename ?? "attachment-" + Math.random().toString(36).slice(2, 8),
      mimeType: att.contentType ?? "application/octet-stream",
      size: att.size ?? 0,
      content: att.content,
      contentId: att.contentId ?? null
    }))
  };
}

export function classifyKind(mimeType: string, filename: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  const name = filename.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|tiff?)$/.test(name)) return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  )
    return "docx";
  if (mime.includes("spreadsheetml") || name.endsWith(".xlsx") || name.endsWith(".xls"))
    return "xlsx";
  if (mime.startsWith("text/plain") || name.endsWith(".txt") || name.endsWith(".csv")) return "text";
  if (mime.startsWith("text/html") || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  return "other";
}

export { simpleParser };
