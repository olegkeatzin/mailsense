import OpenAI from "openai";
import type { AiConfig } from "../config.js";

/**
 * Распознавание отчёта об исполнении в ответе на письмо-поручение (этап 4).
 *
 * Почему модель, а не список формулировок: отчёт пишут живым языком — «сделал», «направил»,
 * «готово, файл во вложении», «созвонились, вопрос снят». Перечислить их регулярками нельзя,
 * а список неизбежно устареет.
 *
 * ⚠️ **Модель только читает, решает человек.** Найденный отчёт становится ПРЕДЛОЖЕНИЕМ и ждёт
 * подтверждения аппарата: ложное закрытие поручения хуже пропущенного отчёта. Пропущенный
 * аппарат увидит в почте и закроет вручную, а закрытое по ошибке — уже нет.
 */
export interface ReportAnalysisInput {
  /** Номер документа — чтобы модель понимала контекст. */
  documentNumber: string;
  /** Текст поручения, на которое отвечают. */
  taskText: string;
  /** Ответ исполнителя. */
  replyText: string;
}

export interface ReportAnalysis {
  /** Похоже ли это на отчёт об исполнении, а не на вопрос или уточнение. */
  isReport: boolean;
  /** Краткая суть сделанного — для очереди аппарата. Пусто, если это не отчёт. */
  summary: string;
}

export const REPORT_PROMPT = [
  "Ты — помощник аппарата, который ведёт контроль исполнения поручений.",
  "Тебе дают текст поручения и письмо-ответ на него. Определи, является ли ответ ОТЧЁТОМ ОБ ИСПОЛНЕНИИ.",
  "",
  "Отчёт об исполнении — это сообщение о том, что поручение выполнено или продвинулось:",
  "  «сделал», «направил», «подготовил и отправил», «готово, файл во вложении», «вопрос решён».",
  "",
  "НЕ отчёт: вопрос («а в какой срок?»), уточнение («кому именно направить?»), отказ,",
  "  пересылка письма без комментария, автоматический ответ, посторонняя переписка.",
  "",
  "Верни СТРОГО JSON без пояснений и без разметки:",
  "  { is_report: true или false, summary: краткая суть сделанного }",
  "",
  "Правила для summary:",
  "  - одна фраза, до 200 символов, деловой стиль, от третьего лица;",
  "  - опирайся ТОЛЬКО на текст ответа, не выдумывай подробностей;",
  "  - если это не отчёт — верни пустую строку."
].join("\n");

/** Сколько символов отчёта принимаем: длинную выжимку аппарат читать не станет. */
const MAX_SUMMARY = 300;

/**
 * Аккуратный разбор ответа модели.
 *
 * Модель может обернуть JSON в разметку или добавить слова вокруг — берём первую
 * фигурную конструкцию. Любая непонятность трактуется как «не отчёт»: молчание безопаснее
 * ложного срабатывания.
 */
export function parseReportAnalysis(raw: string): ReportAnalysis {
  const text = (raw ?? "").trim();
  if (!text) return { isReport: false, summary: "" };
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { isReport: false, summary: "" };
  try {
    const obj = JSON.parse(match[0]) as { is_report?: unknown; summary?: unknown };
    const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, MAX_SUMMARY) : "";
    // Отчёт без описания бессмысленен: аппарату нечего проверять.
    const isReport = obj.is_report === true && summary.length > 0;
    return { isReport, summary: isReport ? summary : "" };
  } catch {
    return { isReport: false, summary: "" };
  }
}

export async function analyzeReportReply(
  cfg: AiConfig,
  input: ReportAnalysisInput,
  signal?: AbortSignal
): Promise<ReportAnalysis> {
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1
  });

  const user = [
    "Документ: " + (input.documentNumber || "без номера"),
    "Поручение: " + (input.taskText || "(текст не указан)"),
    "",
    "Ответ исполнителя:",
    input.replyText.trim() || "(пусто)"
  ].join("\n");

  const resp = await client.chat.completions.create(
    {
      model: cfg.model,
      messages: [
        { role: "system", content: REPORT_PROMPT },
        { role: "user", content: user }
      ],
      // Классификация, а не творчество: нужен предсказуемый ответ.
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" as const },
      // «Думающие» модели без этого тратят весь бюджет на рассуждение и возвращают пустоту.
      chat_template_kwargs: { enable_thinking: false }
    } as never,
    { signal }
  );

  return parseReportAnalysis(resp.choices[0]?.message?.content ?? "");
}