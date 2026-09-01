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
    timeoutMs: base.timeoutMs
  };
}

export function setAiConfig(cfg: Partial<AiConfig>): void {
  if (cfg.baseUrl) setSetting("ai.baseUrl", cfg.baseUrl);
  if (cfg.apiKey) setSetting("ai.apiKey", cfg.apiKey);
  if (cfg.model) setSetting("ai.model", cfg.model);
  if (cfg.multimodal !== undefined) setSetting("ai.multimodal", String(cfg.multimodal));
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
