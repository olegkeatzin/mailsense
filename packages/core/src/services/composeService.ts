import fs from "node:fs";
import { getAccount, getEmailView } from "../repos.js";
import { baseSubject } from "./threadService.js";
import type { AccountSettings, EmailAddress, EmailView } from "../types.js";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeTemplateAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
}

/** Готовый шаблон письма (ответ/пересылка/новое) с подписью и цитатой. */
export interface ComposeTemplate {
  accountId: string;
  mode: ComposeMode;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyToEmailId: string | null;
  inReplyToMessageId: string | null;
  references: string[];
  attachments: ComposeTemplateAttachment[];
}

export interface SignatureOptions {
  /** Готовый HTML подписи (WYSIWYG). Если задан — используется вместо text. */
  html?: string | null;
  text?: string;
  enabled?: boolean;
  /** Положение подписи относительно цитаты. */
  position?: "above" | "below";
  /** Добавлять стандартный разделитель подписи "-- " (Thunderbird). */
  delimiter?: boolean;
}

function esc(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function formatAddress(a: EmailAddress | null | undefined): string {
  if (!a) return "";
  return a.name ? a.name + " <" + a.address + ">" : a.address;
}

/** Дата для строки атрибуции/заголовка пересылки (локальная зона, без ICU-зависимостей). */
export function formatDateHuman(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

export function replySubject(subject: string): string {
  return "Re: " + baseSubject(subject ?? "");
}

export function forwardSubject(subject: string): string {
  return "Fwd: " + baseSubject(subject ?? "");
}

/** Строка «29.09.2026 21:04, Иванов И.И. пишет:». */
export function formatAttribution(
  date: string | null,
  from: EmailAddress | null,
  lang: "ru" | "en" = "ru"
): string {
  const when = formatDateHuman(date);
  const who = from ? from.name || from.address : lang === "en" ? "(unknown sender)" : "(неизвестный отправитель)";
  if (lang === "en") return "On " + (when ? when + ", " : "") + who + " wrote:";
  return (when ? when + ", " : "") + who + " пишет:";
}

/** Текстовая цитата: каждая строка оригинала получает «> ». */
export function quotePlainText(text: string): string {
  return (text ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => "> " + l).join("\n");
}

/** HTML-цитата: строка атрибуции + blockquote с оригиналом. */
export function quoteHtml(attribution: string, bodyHtml: string | null, bodyText: string): string {
  const inner = bodyHtml && bodyHtml.trim()
    ? bodyHtml
    : '<pre style="white-space:pre-wrap">' + esc(bodyText) + "</pre>";
  const head = attribution ? '<p class="mailsense-attribution">' + esc(attribution) + "</p>" : "";
  return head + '<blockquote style="border-left:2px solid #d0d0d0;margin:8px 0;padding-left:10px;color:#555">' + inner + "</blockquote>";
}

export function signatureText(sig: SignatureOptions | undefined): string {
  if (sig?.enabled === false) return "";
  const text = (sig?.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  return (sig?.delimiter === false ? "" : "-- \n") + text;
}

export function signatureHtml(sig: SignatureOptions | undefined): string {
  if (sig?.enabled === false) return "";
  const delim = sig?.delimiter === false ? "" : '<div class="mailsense-signature-delim">-- </div>';
  // Приоритет — подпись из WYSIWYG; текстовая версия остаётся фолбэком.
  const rich = (sig?.html ?? "").trim();
  if (rich && rich !== "<p></p>") return '<div class="mailsense-signature">' + delim + rich + "</div>";
  const text = (sig?.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  return '<div class="mailsense-signature">' + delim + esc(text).replace(/\n/g, "<br>") + "</div>";
}

export function signatureOptions(settings: AccountSettings): SignatureOptions {
  return {
    text: typeof settings.signature === "string" ? settings.signature : "",
    html: typeof settings.signatureHtml === "string" ? settings.signatureHtml : null,
    enabled: settings.signatureEnabled !== false,
    position: settings.signaturePosition === "above" ? "above" : "below",
    delimiter: settings.signatureDelimiter !== false
  };
}

/**
 * References для ответа = цепочка оригиналов (от старых к новым) + Message-ID
 * родителя. Дубликаты и угловые скобки убираются.
 */
export function buildReferences(original: { messageId: string; references?: string[] }): string[] {
  const chain = [...(original.references ?? []), original.messageId];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of chain) {
    const bare = String(raw ?? "").trim().replace(/^</, "").replace(/>$/, "");
    if (!bare) continue;
    const key = bare.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bare);
  }
  return out;
}

function joinText(parts: string[]): string {
  return parts.map((p) => p.replace(/^\n+|\n+$/g, "")).filter(Boolean).join("\n\n");
}

/**
 * Собирает шаблон письма: получателей, тему, тело (текст + HTML) с цитатой и
 * подписью, заголовки треда и (для пересылки) вложения оригинала.
 */
export function buildComposeTemplate(input: {
  accountId: string;
  mode: ComposeMode;
  emailId?: string | null;
}): ComposeTemplate {
  const account = getAccount(input.accountId);
  if (!account) throw new Error("Аккаунт не найден");

  const settings = account.settings as AccountSettings;
  const sig = signatureOptions(settings);
  const sigT = signatureText(sig);
  const sigH = signatureHtml(sig);
  const above = sig.position === "above";
  const lang = settings.replyAttribution === "en" ? "en" : "ru";

  const tpl: ComposeTemplate = {
    accountId: account.id,
    mode: input.mode,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyText: "",
    bodyHtml: "",
    inReplyToEmailId: null,
    inReplyToMessageId: null,
    references: [],
    attachments: []
  };

  if (input.mode === "new" || !input.emailId) {
    tpl.bodyText = sigT ? "\n\n" + sigT : "";
    tpl.bodyHtml = "<p></p>" + sigH;
    return tpl;
  }

  const view: EmailView | null = getEmailView(input.emailId);
  if (!view) throw new Error("Письмо не найдено");

  const self = account.username.toLowerCase();
  const isSelf = (a: EmailAddress): boolean => (a.address ?? "").toLowerCase() === self;

  if (input.mode === "reply" || input.mode === "replyAll") {
    const replyTo = view.replyTo && view.replyTo.length ? view.replyTo : view.from ? [view.from] : [];
    tpl.subject = replySubject(view.subject);
    tpl.to = replyTo;

    if (input.mode === "replyAll") {
      const toKeys = new Set(replyTo.map((a) => (a.address ?? "").toLowerCase()));
      const ccMap = new Map<string, EmailAddress>();
      for (const a of [...view.to, ...(view.cc ?? [])]) {
        const key = (a.address ?? "").toLowerCase();
        if (!key || toKeys.has(key) || key === self || isSelf(a)) continue;
        if (!ccMap.has(key)) ccMap.set(key, a);
      }
      tpl.cc = [...ccMap.values()];
    }

    tpl.inReplyToEmailId = view.id;
    tpl.inReplyToMessageId = view.messageId;
    tpl.references = buildReferences(view);

    let quoteT = "";
    let quoteH = "";
    if (settings.replyQuote !== false) {
      const attribution = view.from ? formatAttribution(view.date, view.from, lang) : "";
      quoteT = attribution ? attribution + "\n" + quotePlainText(view.bodyText) : quotePlainText(view.bodyText);
      quoteH = quoteHtml(attribution, view.bodyHtml, view.bodyText);
    }

    if (above) {
      tpl.bodyText = joinText([sigT, quoteT]);
      tpl.bodyHtml = "<p></p>" + sigH + quoteH;
    } else {
      tpl.bodyText = joinText([quoteT, sigT]);
      tpl.bodyHtml = "<p></p>" + quoteH + sigH;
    }
    tpl.bodyText = tpl.bodyText ? "\n\n" + tpl.bodyText : "";
    return tpl;
  }

  // forward
  tpl.subject = forwardSubject(view.subject);
  const headerT = [
    "-------- Перенаправленное сообщение --------",
    "Тема: " + (view.subject || ""),
    "От: " + formatAddress(view.from),
    "Дата: " + formatDateHuman(view.date),
    "Кому: " + view.to.map(formatAddress).join(", ")
  ].join("\n");
  const headerH =
    '<div class="mailsense-forward-header">' +
    "<div>-------- Перенаправленное сообщение --------</div>" +
    "<div><b>Тема:</b> " + esc(view.subject || "") + "</div>" +
    "<div><b>От:</b> " + esc(formatAddress(view.from)) + "</div>" +
    "<div><b>Дата:</b> " + esc(formatDateHuman(view.date)) + "</div>" +
    "<div><b>Кому:</b> " + esc(view.to.map(formatAddress).join(", ")) + "</div>" +
    "</div>";
  const bodyT = headerT + "\n\n" + (view.bodyText || "");
  const bodyH = headerH + (view.bodyHtml && view.bodyHtml.trim() ? view.bodyHtml : '<pre style="white-space:pre-wrap">' + esc(view.bodyText) + "</pre>");

  if (above) {
    tpl.bodyText = joinText([sigT, bodyT]);
    tpl.bodyHtml = "<p></p>" + sigH + bodyH;
  } else {
    tpl.bodyText = joinText([bodyT, sigT]);
    tpl.bodyHtml = "<p></p>" + bodyH + sigH;
  }
  tpl.bodyText = tpl.bodyText ? "\n\n" + tpl.bodyText : "";

  if (settings.forwardAttachments !== false) {
    for (const att of view.attachments) {
      if (!att.storagePath || !fs.existsSync(att.storagePath)) continue;
      tpl.attachments.push({
        filename: att.filename,
        mimeType: att.mimeType,
        data: fs.readFileSync(att.storagePath).toString("base64")
      });
    }
  }
  return tpl;
}
