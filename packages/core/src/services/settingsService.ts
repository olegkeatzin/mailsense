import type { AiConfig } from "../config.js";
import { getContext } from "../context.js";
import { getSetting, setSetting, listSettings } from "../repos.js";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from "../ai/prompt.js";

export function getAiConfig(): AiConfig {
  const base = getContext().config.ai;
  return {
    baseUrl: getSetting("ai.baseUrl") ?? base.baseUrl,
    apiKey: getSetting("ai.apiKey") ?? base.apiKey,
    model: getSetting("ai.model") ?? base.model,
    multimodal: (getSetting("ai.multimodal") ?? String(base.multimodal)) === "true",
    timeoutMs: base.timeoutMs,
    ocrBaseUrl: getSetting("ai.ocrBaseUrl") ?? undefined,
    ocrModel: getSetting("ai.ocrModel") ?? undefined
  };
}

export function setAiConfig(cfg: Partial<AiConfig>): void {
  if (cfg.baseUrl) setSetting("ai.baseUrl", cfg.baseUrl);
  if (cfg.apiKey) setSetting("ai.apiKey", cfg.apiKey);
  if (cfg.model) setSetting("ai.model", cfg.model);
  if (cfg.multimodal !== undefined) setSetting("ai.multimodal", String(cfg.multimodal));
  if (cfg.ocrBaseUrl !== undefined) setSetting("ai.ocrBaseUrl", cfg.ocrBaseUrl);
  if (cfg.ocrModel !== undefined) setSetting("ai.ocrModel", cfg.ocrModel);
}

/** Конфиг OCR-модели: отдельная модель или fallback на основную. */
export function getOcrConfig(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number } {
  const ai = getAiConfig();
  return {
    baseUrl: ai.ocrBaseUrl || ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.ocrModel || ai.model,
    timeoutMs: ai.timeoutMs
  };
}

export function getSettingValue(key: string, fallback = ""): string {
  return getSetting(key) ?? fallback;
}

export function setSettingValue(key: string, value: string): void {
  setSetting(key, value);
}

export function getAllSettings(): Record<string, string> {
  return listSettings();
}

export interface PromptSettings {
  system: string;
  userTemplate: string;
}

export function getPromptSettings(): PromptSettings {
  return {
    system: getSetting("ai.systemPrompt") ?? DEFAULT_SYSTEM_PROMPT,
    userTemplate: getSetting("ai.userTemplate") ?? DEFAULT_USER_TEMPLATE
  };
}

export function setPromptSettings(p: Partial<PromptSettings>): void {
  if (p.system !== undefined) setSetting("ai.systemPrompt", p.system);
  if (p.userTemplate !== undefined) setSetting("ai.userTemplate", p.userTemplate);
}
