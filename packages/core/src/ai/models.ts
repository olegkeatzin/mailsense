import OpenAI from "openai";

export interface AiTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

/**
 * Проверяет доступность OpenAI-совместимого эндпоинта (GET /models)
 * и возвращает список доступных моделей.
 */
export async function testAiConnection(cfg: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<AiTestResult> {
  try {
    const client = new OpenAI({
      apiKey: cfg.apiKey || "not-needed",
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs ?? 30000,
      maxRetries: 0
    });
    const list = await client.models.list();
    const models = (list.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
    return { ok: true, models };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e?.message || String(err) };
  }
}
