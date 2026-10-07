import { escapeHtml } from "./text";
import type { MailProfile } from "../types";

/**
 * Личная подпись работника (T36). Поля профиля — camelCase, как в контракте ядра
 * и маршрута /api/mail-profile: displayName, signatureText, signatureEnabled,
 * signaturePosition ("above"|"below"), replyQuote, replyAttribution ("ru"|"en").
 *
 * Подпись ЯЩИКА в письмо не попадает: шаблон запрашивается с useAccountSignature=false,
 * а тело дополняет клиент по ЛИЧНЫМ настройкам. Пустой профиль или выключенная подпись —
 * ничего не подставляем: лучше письмо без подписи, чем чужая.
 */
export function personalSignatureHtml(profile: MailProfile | null | undefined): string {
  if (!profile || profile.signatureEnabled === false) return "";
  const text = (profile.signatureText ?? "").trim();
  if (!text) return "";
  const body = escapeHtml(text).replace(/\n/g, "<br>");
  return (
    '<div class="mailsense-signature mailsense-signature-personal">' +
    '<div class="mailsense-signature-delim">-- </div>' +
    body +
    "</div>"
  );
}

/** Убирает цитату, если работник отвечает без неё (настройка replyQuote). */
export function withoutQuote(bodyHtml: string, profile: MailProfile | null | undefined): string {
  const body = bodyHtml ?? "";
  if (!profile || profile.replyQuote !== false) return body;
  const lower = body.toLowerCase();
  const start = lower.indexOf("<blockquote");
  if (start < 0) return body;
  const close = lower.indexOf("</blockquote>", start);
  if (close < 0) return body.slice(0, start);
  return body.slice(0, start) + body.slice(close + "</blockquote>".length);
}

/**
 * Тело письма с личной подписью.
 * above — подпись встаёт ПЕРЕД цитатой, below — после неё (или в конце письма).
 */
export function applyPersonalSignature(bodyHtml: string, profile: MailProfile | null | undefined): string {
  const body = bodyHtml ?? "";
  const signature = personalSignatureHtml(profile);
  if (!signature) return body;
  const quoteAt = body.toLowerCase().indexOf("<blockquote");
  if (profile?.signaturePosition === "above" && quoteAt >= 0) {
    return body.slice(0, quoteAt) + signature + body.slice(quoteAt);
  }
  return body + signature;
}

/**
 * Профиль не заполнен: ни имени подписи, ни её текста.
 * `signatureEnabled === false` — это «подпись выключена», а не «не заполнено».
 */
export function isProfileEmpty(profile: MailProfile | null | undefined): boolean {
  if (!profile) return true;
  return !(profile.displayName ?? "").trim() && !(profile.signatureText ?? "").trim();
}
