/**
 * Распознавание ответа руководителя на запрос резолюции (способ В, шаг 1).
 *
 * Аппарат направил письмо руководителю, тот ответил — ответ приходит в тред, потому что
 * при отправке мы проставили `In-Reply-To` и `References` на исходное письмо. Здесь мы
 * этот ответ находим.
 *
 * ⚠️ **Решение не принимается автоматически.** Найденный ответ только переводит резолюцию
 * в состояние «ждёт подтверждения» — утвердить её должен человек в аппарате (Р9). Разбор
 * свободного текста не может быть основанием для официального поручения: «согласен» и
 * «согласен, но исполнитель другой» отличаются одной оговоркой, а поручение уходит живым людям.
 *
 * Функция чистая намеренно: сопоставление по треду — это то место, где ошибка тихо ломает
 * процесс, и его нужно проверять тестами без базы и без почты.
 */

/** Резолюция, ждущая ответа руководителя. */
export interface AwaitingApproval {
  resolutionId: string;
  /** Message-ID письма, которое аппарат направил руководителю. */
  requestMessageId: string | null;
}

/** Письмо, пришедшее в ящик и похожее на ответ. */
export interface ReplyCandidate {
  emailId: string;
  inReplyTo: string | null;
  references: string[];
  /** Заголовки письма: в них наша техническая метка СЭД (если письмо наше). */
  headers?: Record<string, unknown> | null;
}

/** Разобранная техническая метка письма СЭД. */
export interface EdmsMarker {
  documentId: string;
  resolutionId: string | null;
  kind: string;
}

/**
 * Разбирает метку X-MailSense-EDMS из заголовков письма.
 *
 * Заказчик: «ставить в письме техническую информацию, по которой наша система на другом
 * конце сможет понять, что это за письмо». Метка сильнее треда: её не ломает пересылка,
 * а заголовки почтовые клиенты сохраняют.
 */
export function parseEdmsMarker(headers: Record<string, unknown> | null | undefined): EdmsMarker | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "x-mailsense-edms");
  if (!key) return null;
  const raw = typeof headers[key] === "string" ? (headers[key] as string) : "";
  if (!raw) return null;
  const parts = new Map<string, string>();
  for (const chunk of raw.split(";")) {
    const [k, v] = chunk.split("=");
    if (!k || v === undefined) continue;
    parts.set(k.trim().toLowerCase(), v.trim());
  }
  const documentId = parts.get("doc") ?? "";
  if (!documentId || documentId === "-") return null;
  const res = parts.get("res") ?? "";
  return {
    documentId,
    resolutionId: res && res !== "-" ? res : null,
    kind: parts.get("kind") ?? "forward"
  };
}

export interface MatchedReply {
  resolutionId: string;
  emailId: string;
}

/** Приводит Message-ID к сравнимому виду: без угловых скобок и в нижнем регистре. */
function bare(id: string | null | undefined): string {
  if (!id) return "";
  return id.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

/**
 * Сопоставляет ответы с ожидающими резолюциями по треду.
 *
 * Сопоставляем и по `In-Reply-To`, и по `References`: почтовые клиенты заполняют их
 * по-разному, а некоторые ставят только цепочку. Ответ БЕЗ признаков треда не считается
 * ответом — иначе резолюцией стало бы любое письмо от руководителя.
 */
export function matchReplies(
  awaiting: AwaitingApproval[],
  replies: ReplyCandidate[]
): MatchedReply[] {
  const byRequest = new Map<string, string>();
  for (const a of awaiting) {
    const id = bare(a.requestMessageId);
    if (id) byRequest.set(id, a.resolutionId);
  }
  if (!byRequest.size) return [];

  const out: MatchedReply[] = [];
  const used = new Set<string>();
  /** Поручения, ждущие ответа: по ним проверяем метку. */
  const awaitingIds = new Set(awaiting.map((a) => a.resolutionId));
  for (const r of replies) {
    // 1) Техническая метка в заголовках: самый надёжный признак — её не ломает пересылка.
    const marker = parseEdmsMarker(r.headers);
    if (marker?.resolutionId && awaitingIds.has(marker.resolutionId) && !used.has(marker.resolutionId)) {
      used.add(marker.resolutionId);
      out.push({ resolutionId: marker.resolutionId, emailId: r.emailId });
      continue;
    }
    // 2) Тред: In-Reply-To и References.
    const chain = [bare(r.inReplyTo), ...(r.references ?? []).map(bare)].filter(Boolean);
    for (const link of chain) {
      const resolutionId = byRequest.get(link);
      if (!resolutionId) continue;
      // Одна резолюция — один ответ: второй ответ того же треда не должен
      // перезаписывать первый (руководитель мог ответить дважды, поправив себя).
      if (used.has(resolutionId)) break;
      used.add(resolutionId);
      out.push({ resolutionId, emailId: r.emailId });
      break;
    }
  }
  return out;
}