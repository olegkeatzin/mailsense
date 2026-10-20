/**
 * Параллельность из окружения: число от 1 и выше, иначе — запасное значение.
 *
 * ⚠️ Раньше здесь стоял просто `Number(...)`. Пустая переменная (`MAILSENSE_AI_CONCURRENCY=`,
 * как в примере .env) даёт `Number("") === 0`, а p-queue на нуле БРОСАЕТ исключение прямо при
 * импорте модуля — контейнер падал с «Expected concurrency to be a number from 1 and up, got 0»
 * ещё до первого запроса. Пустая настройка не должна ронять приложение.
 *
 * Функция в отдельном файле без зависимостей: проверяется тестами напрямую (p-queue — ESM).
 */
export function concurrencyFromEnv(raw: string | undefined | null, fallback: number): number {
  const base = Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1;
  const value = Number(String(raw ?? "").trim());
  if (!Number.isFinite(value) || value < 1) return base;
  return Math.floor(value);
}
