import OpenAI from "openai";
import type { AiConfig } from "../config.js";
import { buildPrompt, type PromptInput } from "./prompt.js";
import { getPromptSettings } from "../services/settingsService.js";

export interface AnalyzeInput {
  subject: string;
  from: string;
  date: string | null;
  bodyText: string;
  attachmentTexts: string[];
  attachmentNotes: string[];
  images: string[]; // data-URL
  attachmentNames: string[];
}

export async function analyzeEmailRaw(
  cfg: AiConfig,
  input: AnalyzeInput,
  signal?: AbortSignal
): Promise<string> {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1
  });

  const prompts = getPromptSettings();
  const text = buildPrompt(
    {
      subject: input.subject,
      from: input.from,
      date: input.date,
      bodyText: input.bodyText,
      attachmentTexts: input.attachmentTexts,
      attachmentNotes: input.attachmentNotes,
      imageCount: input.images.length,
      attachmentNames: input.attachmentNames
    },
    { system: prompts.system, userTemplate: prompts.userTemplate }
  );

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text }
  ];
  for (const img of input.images) {
    content.push({ type: "image_url", image_url: { url: img } });
  }

  const resp = await client.chat.completions.create(
    {
      model: cfg.model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 4000
    },
    { signal }
  );

  return resp.choices[0]?.message?.content ?? "";
}
