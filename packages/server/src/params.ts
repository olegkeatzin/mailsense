import { AppError } from "@mailsense/docflow";

export interface IntParamOptions {
  /** Значение, когда параметр не передан вовсе. */
  fallback: number;
  /** Нижняя граница: значение меньше приводится к ней. */
  min?: number;
  /** Верхняя граница: значение больше приводится к ней. */
  max?: number;
}

/**
 * Разбирает целое число из query-параметра.
 *
 * ⚠️ Раньше стояло Number(req.query.limit): «?limit=abc» давало NaN, NaN уходил в SQL
 * (LIMIT NaN), и клиент получал 500 с ошибкой драйвера вместо понятного отказа.
 * Теперь: пусто — значение по умолчанию, мусор — 400 с именем параметра,
 * выход за границы — приведение к границе (в SQL уходит только целое).
 */
export function intParam(value: unknown, name: string, options: IntParamOptions): number {
  // ?limit=1&limit=2 Express отдаёт массивом — берём последнее значение.
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (raw === undefined || raw === null || raw === "") return options.fallback;

  const text = String(raw).trim();
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new AppError(
      "Параметр " + name + " должен быть целым числом, получено: " + text,
      400,
      "bad_param"
    );
  }

  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, parsed));
}
