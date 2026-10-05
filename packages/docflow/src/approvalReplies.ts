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
  for (const r of replies) {
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