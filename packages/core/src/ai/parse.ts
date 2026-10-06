import { z } from "zod";

/**
 * Необязательный текст: пустая строка (в том числе из пробелов) — это отсутствие
 * значения. Модель часто отвечает "event_date": "", и раньше пустая строка
 * доезжала до базы как «дата», попадая в фильтр «есть дата события».
 */
const optionalText = z
  .string()
  .nullable()
  .default(null)
  .transform((v) => (v && v.trim() ? v : null));

export const analysisSchema = z.object({
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  priority: z.number().int().min(1).max(5).default(3),
  urgent: z.boolean().default(false),
  event_date: optionalText,
  external_number: optionalText,
  external_number_source: z
    .object({
      filename: z.string(),
      page: z.number().int().positive().default(1)
    })
    .nullable()
    .default(null),
  send_date: optionalText,
  category: z.enum(["work", "personal", "spam"]).default("personal"),
  attachments: z.array(z.object({ name: z.string(), description: z.string() })).default([])
});

export type ParsedAnalysis = z.infer<typeof analysisSchema>;

export function extractJson(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function parseAnalysis(raw: string): ParsedAnalysis {
  const json = extractJson(raw);
  const obj = JSON.parse(json);
  return analysisSchema.parse(obj);
}
