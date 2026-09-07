import OpenAI from "openai";

export interface OcrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export const OCR_PROMPT = [
  "Прочитай документ на изображении.",
  "Выведи ТОЛЬКО содержимое документа в формате Markdown, точно сохраняя:",
  "- шапку/бланк отправителя: организация, дата отправки, исходящий/внешний номер;",
  "- таблицы, списки, реквизиты, суммы, даты;",
  "- порядок чтения сверху вниз.",
  "Ничего не пересказывай, не добавляй пояснений — только текст документа."
].join("\n");

/**
 * Читает одну страницу/изображение документа через OCR-модель (vision)
 * и возвращает распознанный текст (Markdown).
 */
export async function ocrImage(cfg: OcrConfig, imageDataUrl: string): Promise<string> {
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1
  });

  const resp = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ],
    temperature: 0,
    max_tokens: 4096
  });

  return resp.choices[0]?.message?.content ?? "";
}
