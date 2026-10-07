/**
 * Список моделей ИИ для подсказки в поле.
 *
 * Запрос необязательный: его отказ (сеть, права, 502) не должен рождать
 * необработанный отказ промиса в консоли. Возвращаем пустой список —
 * поле остаётся работоспособным, человек вводит модель руками.
 */
export async function loadAiModelList(
  testAi: (args: { baseUrl: string; apiKey?: string }) => Promise<{ ok: boolean; models?: string[] }>,
  url: string,
  apiKey?: string
): Promise<string[]> {
  if (!url) return [];
  try {
    const r = await testAi({ baseUrl: url, apiKey });
    return r?.ok ? r.models ?? [] : [];
  } catch {
    return [];
  }
}
