import OpenAI from "openai";
import type { AiConfig } from "../config.js";

/**
 * Черновик резолюции по входящему письму.
 *
 * Модель формулирует ТОЛЬКО текст поручения. Исполнителей и срок она не подставляет:
 * фамилий она не знает (штатного расписания в системе нет), а срок исполнения —
 * решение человека, а не пересказ письма (Р7). И то и другое вписывает аппарат.
 */
export interface ResolutionDraftInput {
  subject: string;
  from: string;
  /** Выжимка, уже сделанная моделью по этому письму. */
  summary: string;
  bodyText: string;
  attachmentTexts: string[];
}


/**
 * Извлекает поручение из ответа руководителя (Р9, способ В).
 *
 * Зачем модель: ответ приходит письмом с цитатой исходного текста и подписью, и подставлять его
 * в резолюцию целиком нельзя. Модель оставляет только то, что руководитель велел сделать.
 *
 * ⚠️ Исполнителей и срок модель НЕ подставляет — это решение человека (Р7). Здесь она только
 * читает написанное, а не додумывает.
 */
export const APPROVAL_EXTRACT_PROMPT = [
  "Ты — помощник аппарата. Руководитель ответил на письмо и тем самым утвердил поручение.",
  "Выдели из его ответа САМО ПОРУЧЕНИЕ: что и кому он велел сделать.",
  "",
  "Правила:",
  "  - убери приветствие, подпись, цитату исходного письма и историю переписки;",
  "  - убери слова согласия («утверждаю», «согласен», «не возражаю») — они не часть поручения;",
  "  - сохрани фамилии и сроки, если руководитель их назвал;",
  "  - ничего не добавляй от себя: только то, что написано в ответе;",
  "  - если поручения в ответе нет — верни пустую строку.",
  "",
  "Верни СТРОГО JSON без пояснений и без разметки:",
  "  { text: текст поручения одной-двумя фразами }"
].join("\n");

/** Разбор ответа модели: непонятное — это пустая строка, а не выдуманный текст. */
export function parseApprovalExtract(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return "";
  try {
    const obj = JSON.parse(match[0]) as { text?: unknown };
    return typeof obj.text === "string" ? obj.text.trim().slice(0, 2000) : "";
  } catch {
    return "";
  }
}

export async function extractApprovalInstruction(
  cfg: AiConfig,
  input: { replyText: string },
  signal?: AbortSignal
): Promise<string> {
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1
  });

  const resp = await client.chat.completions.create(
    {
      model: cfg.model,
      messages: [
        { role: "system", content: APPROVAL_EXTRACT_PROMPT },
        { role: "user", content: input.replyText.trim() || "(пусто)" }
      ],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" as const },
      chat_template_kwargs: { enable_thinking: false }
    } as never,
    { signal }
  );

  return parseApprovalExtract(resp.choices[0]?.message?.content ?? "");
}

export const RESOLUTION_PROMPT = [
  "Ты — помощник аппарата генерального директора.",
  "По входящему письму составь ПРОЕКТ резолюции руководителя.",
  "",
  "Требования:",
  "- Деловой стиль, как в резолюциях: «Подготовить…», «Рассмотреть…», «Направить…».",
  "- Нумерованный список поручений (1., 2., 3.), каждое — конкретное действие.",
  "- Опирайся ТОЛЬКО на текст письма и вложений. Не выдумывай факты, суммы, даты и организации.",
  "- НЕ указывай исполнителей по фамилиям — их впишет аппарат.",
  "- НЕ назначай срок исполнения. Если в письме упомянут срок (например, «заявку до 07.09.2026»),",
  "  приведи его внутри поручения как часть условия, но не как срок исполнения резолюции.",
  "- Не добавляй вступлений вроде «Вот проект резолюции» и пояснений — только текст резолюции.",
  "- Пиши на русском языке."
].join("\n");

function buildUserMessage(input: ResolutionDraftInput): string {
  const parts = [
    "Тема письма: " + (input.subject || "(без темы)"),
    "Отправитель: " + (input.from || "(неизвестен)")
  ];
  if (input.summary.trim()) parts.push("Краткое содержание: " + input.summary.trim());
  parts.push("", "Текст письма:", input.bodyText.trim() || "(пусто)");
  if (input.attachmentTexts.length) {
    parts.push("", "Текст вложений:");
    for (const t of input.attachmentTexts) {
      if (t.trim()) parts.push("---", t.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Возвращает текст черновика. Пустая строка означает, что модель ничего не предложила —
 * вызывающий код обязан показать это аппарату, а не подставлять пустоту молча.
 */
export async function draftResolution(
  cfg: AiConfig,
  input: ResolutionDraftInput,
  signal?: AbortSignal
): Promise<string> {
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1
  });

  const resp = await client.chat.completions.create(
    {
      model: cfg.model,
      messages: [
        { role: "system", content: RESOLUTION_PROMPT },
        { role: "user", content: buildUserMessage(input) }
      ],
      // temperature 0: формулировка поручения не должна «фантазировать».
      temperature: 0,
      max_tokens: 1024,
      // «Думающие» модели без этого тратят весь бюджет на рассуждение и возвращают пустоту.
      chat_template_kwargs: { enable_thinking: false }
    } as never,
    { signal }
  );

  return (resp.choices[0]?.message?.content ?? "").trim();
}