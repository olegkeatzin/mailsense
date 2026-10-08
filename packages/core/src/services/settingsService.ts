import { DEFAULT_OCR_MAX_PAGES, DEFAULT_TEXT_MAX_PAGES, type AiConfig } from "../config.js";
import { getContext } from "../context.js";
import { getSetting, setSetting, listSettings } from "../repos.js";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from "../ai/prompt.js";

/**
 * Пустая строка (в том числе из одних пробелов) — это «не задано».
 * Нужно, чтобы пустая переменная окружения не перебивала fallback на основную модель.
 */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed || undefined;
}

export function getAiConfig(): AiConfig {
  const base = getContext().config.ai;
  return {
    baseUrl: getSetting("ai.baseUrl") ?? base.baseUrl,
    apiKey: getSetting("ai.apiKey") ?? base.apiKey,
    model: getSetting("ai.model") ?? base.model,
    multimodal: (getSetting("ai.multimodal") ?? String(base.multimodal)) === "true",
    timeoutMs: base.timeoutMs,
    // Приоритет: настройка в базе (админ поменял через интерфейс) → переменная окружения →
    // пусто, и тогда getOcrConfig уходит на основную модель и адрес. Пустое значение
    // (в том числе из пробелов) — это «не задано», а не заданный пустой адрес.
    ocrBaseUrl: nonEmpty(getSetting("ai.ocrBaseUrl")) ?? nonEmpty(base.ocrBaseUrl),
    ocrModel: nonEmpty(getSetting("ai.ocrModel")) ?? nonEmpty(base.ocrModel),
    concurrency: Number(getSetting("ai.concurrency") ?? "1"),
    ocrConcurrency: Number(getSetting("ai.ocrConcurrency") ?? "3"),
    ocrMaxPages: readPageLimit(
      getSetting("ai.ocrMaxPages") ?? String(base.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES),
      DEFAULT_OCR_MAX_PAGES
    ),
    textMaxPages: readPageLimit(
      getSetting("ai.textMaxPages") ?? String(base.textMaxPages ?? DEFAULT_TEXT_MAX_PAGES),
      DEFAULT_TEXT_MAX_PAGES
    )
  };
}

/** Верхняя граница лимита страниц: защита от «прочитать 100 000 страниц» из настроек. */
const MAX_PAGE_LIMIT = 200;

/**
 * Мусор в настройке не должен превращаться в NaN или в бесконечный цикл рендера:
 * нецелое, ноль, отрицательное и выход за диапазон трактуем как дефолт.
 */
function readPageLimit(raw: string | number, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_LIMIT ? n : fallback;
}

/** Сколько страниц PDF рендерить и распознавать OCR (настройка ai.ocrMaxPages). */
export function getOcrMaxPages(): number {
  const base = getContext().config.ai.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES;
  return readPageLimit(getSetting("ai.ocrMaxPages") ?? String(base), DEFAULT_OCR_MAX_PAGES);
}

/** Сколько страниц PDF читать из текстового слоя (настройка ai.textMaxPages). */
export function getTextMaxPages(): number {
  const base = getContext().config.ai.textMaxPages ?? DEFAULT_TEXT_MAX_PAGES;
  return readPageLimit(getSetting("ai.textMaxPages") ?? String(base), DEFAULT_TEXT_MAX_PAGES);
}

export function setAiConfig(cfg: Partial<AiConfig>): void {
  if (cfg.baseUrl) setSetting("ai.baseUrl", cfg.baseUrl);
  if (cfg.apiKey) setSetting("ai.apiKey", cfg.apiKey);
  if (cfg.model) setSetting("ai.model", cfg.model);
  if (cfg.multimodal !== undefined) setSetting("ai.multimodal", String(cfg.multimodal));
  if (cfg.ocrBaseUrl !== undefined) setSetting("ai.ocrBaseUrl", cfg.ocrBaseUrl);
  if (cfg.ocrModel !== undefined) setSetting("ai.ocrModel", cfg.ocrModel);
  if (cfg.concurrency !== undefined) setSetting("ai.concurrency", String(cfg.concurrency));
  if (cfg.ocrConcurrency !== undefined) setSetting("ai.ocrConcurrency", String(cfg.ocrConcurrency));
  if (cfg.ocrMaxPages !== undefined) setSetting("ai.ocrMaxPages", String(cfg.ocrMaxPages));
  if (cfg.textMaxPages !== undefined) setSetting("ai.textMaxPages", String(cfg.textMaxPages));
}

/** Параллельность запросов к основной (summary) модели. */
export function getAnalysisConcurrency(): number {
  return Math.max(1, Number(getSetting("ai.concurrency") ?? "1") || 1);
}

/** Параллельность запросов к OCR-модели. */
export function getOcrConcurrency(): number {
  return Math.max(1, Number(getSetting("ai.ocrConcurrency") ?? "3") || 3);
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
