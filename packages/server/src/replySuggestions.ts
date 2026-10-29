import {
  analyzeReportReply,
  extractApprovalInstruction,
  getAccountById,
  getAiConfig,
  getEmailView,
  logger
} from "@mailsense/core";
import { listReplyCandidates, matchReplies, type ThreadReplyCandidate } from "@mailsense/docflow";
import { executorsFromReply } from "./replyExecutors.js";

export { executorsFromReply };

/**
 * Подсказки аппарату по письму-ответу (Р9, этап 4).
 *
 * ⚠️ **Система НЕ определяет, что это за письмо.** Ответ это резолюции или отчёт об исполнении —
 * решает работник аппарата, открыв письмо в почте. ИИ тоже не классифицирует: он только помогает
 * заполнить поля, которые аппарат потом проверит и поправит.
 *
 * Что делает система — сообщает ФАКТ: письмо находится в переписке по такому-то поручению
 * (`In-Reply-To`/`References` — это не догадка, а данные из заголовков). Дальше выбор за человеком.
 *
 * Ничего не происходит само: ни при сканировании ящика, ни при открытии письма. Модель вызывается
 * только когда аппарат нажал «Заполнить с помощью ИИ».
 */

export interface ReplyContextItem {
  resolutionId: string;
  /** Чего ждёт поручение: подсказка для аппарата, а не решение. */
  expects: "approval" | "report";
  documentNumber: string;
  documentSummary: string;
  taskText: string;
  assignees: Array<{ userId: string; fullName: string; kind: string }>;
  /**
   * Текст ответа — черновик резолюции. Руководитель мог отвечать из Outlook,
   * и тогда текст резолюции есть только в письме.
   */
  replyText: string;
  /**
   * Исполнители, НАЗВАННЫЕ РУКОВОДИТЕЛЕМ В ПИСЬМЕ: получатели и копия, кроме нашего
   * служебного ящика и самого руководителя (решение заказчика). Аппарат их подтверждает.
   */
  executorCandidates: Array<{ address: string; name: string }>;
}


/**
 * В переписке ли это письмо и по какому поручению.
 *
 * Возвращает список, потому что в треде может быть несколько поручений — тогда выбирает аппарат.
 */
export async function findReplyContext(emailId: string): Promise<ReplyContextItem[]> {
  const mail = getEmailView(emailId);
  if (!mail) return [];

  const candidates: ThreadReplyCandidate[] = await listReplyCandidates();
  if (!candidates.length) return [];

  // Message-ID писем-поручений берём из почты: в docflow хранятся идентификаторы писем,
  // а тред строится по заголовкам.
  const requests = new Map<string, string | null>();
  for (const c of candidates) requests.set(c.resolutionId, getEmailView(c.emailId)?.messageId ?? null);

  const matches = matchReplies(
    candidates.map((c) => ({ resolutionId: c.resolutionId, requestMessageId: requests.get(c.resolutionId) ?? null })),
    [
      {
        emailId: mail.id,
        inReplyTo: mail.inReplyTo ?? null,
        references: mail.references ?? [],
        // Метка СЭД: по ней письмо узнаётся даже после пересылки (жалоба заказчика).
        headers: mail.headers ?? null
      }
    ]
  );
  const ids = new Set(matches.map((m) => m.resolutionId));

  // Наши адреса: ящик, из которого ушёл запрос, и он же — «служебный» для письма.
  const ownAccount = mail.accountId ? getAccountById(mail.accountId) : null;
  const executorCandidates = executorsFromReply({
    from: mail.from?.address ?? "",
    to: mail.to ?? [],
    cc: mail.cc ?? [],
    exclude: ownAccount ? [ownAccount.username] : []
  });
  const replyText = (mail.bodyText ?? "").trim();

  return candidates
    .filter((c) => ids.has(c.resolutionId))
    .map((c) => ({
      replyText,
      executorCandidates,
      resolutionId: c.resolutionId,
      expects: c.expects,
      documentNumber: c.documentNumber,
      documentSummary: c.documentSummary,
      taskText: c.taskText,
      assignees: c.assignees
    }));
}

/**
 * Предложение по полям формы — черновик, а не заполнение.
 *
 * Аппарат решает, что это за письмо, и просит помочь с полями. Модель:
 *   - для отчёта — коротко пересказывает, что сделано;
 *   - для резолюции — очищает ответ руководителя от цитаты, подписи и слов согласия.
 *
 * Недоступность модели — не ошибка: аппарат заполнит поля сам.
 */
export async function suggestFields(
  emailId: string,
  kind: "approval" | "report"
): Promise<{ text: string; source: "ai" | "none" }> {
  const mail = getEmailView(emailId);
  if (!mail) return { text: "", source: "none" };
  const reply = (mail.bodyText ?? "").trim();
  if (!reply) return { text: "", source: "none" };

  const cfg = getAiConfig();
  // Контекст поручения улучшает черновик: модель видит, что именно поручено,
  // и не считает ответ «не отчётом» только из-за короткой фразы.
  let context: { documentNumber: string; taskText: string } | undefined;
  try {
    const found = await findReplyContext(emailId);
    if (found[0]) context = { documentNumber: found[0].documentNumber, taskText: found[0].taskText };
  } catch {
    /* контекст необязателен */
  }
  try {
    if (kind === "report") {
      const a = await analyzeReportReply(cfg, {
        documentNumber: context?.documentNumber ?? "",
        taskText: context?.taskText ?? "",
        replyText: reply
      });
      if (a.summary) return { text: a.summary, source: "ai" };
    } else {
      const text = await extractApprovalInstruction(cfg, { replyText: reply });
      if (text) return { text, source: "ai" };
    }
  } catch (err) {
    logger.warn({ emailId, kind, err: (err as Error).message }, "Не удалось предложить поля");
  }

  // Модель недоступна или не увидела отчёт — не оставляем человека с пустым полем:
  // отдаём очищенный текст письма как черновик, который он обязан проверить.
  const fallback = reply
    .replace(/\r/g, "")
    .split(/\n(?:--\s*|—\s*|>|С уважением,?\s*$)/i)[0]
    .trim()
    .slice(0, 300);
  return { text: fallback, source: "none" };
}