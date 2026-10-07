/**
 * Сроки: сколько дней осталось и просрочен ли срок.
 *
 * ⚠️ Считаем в КАЛЕНДАРНЫХ днях, а не «ceil(разница в миллисекундах)»: прежняя
 * реализация давала 1 для срока СЕГОДНЯ и 0 для ВЧЕРАШНЕГО. Из-за этого уведомление
 * «срок сегодня» приходило бы на уже просроченное поручение, а «осталось 1 день» —
 * на сегодняшнее; та же ошибка была видна в «Моих задачах». Клиент считает дни по дате
 * (packages/web/src/utils/deadline.ts), поэтому сервер обязан считать так же.
 *
 * Даты — только YYYY-MM-DD (или ISO-строка, начинающаяся с даты). Сравниваем в UTC-полночь:
 * new Date("2026-10-10") в разных часовых поясах даёт разный день, и «сегодня»
 * превращалось бы во «вчера». Мусор на входе — null, а не NaN.
 */
const DAY_MS = 86_400_000;

/** Начало дня (UTC-полночь) для строки с датой; null — если даты в строке нет. */
function startOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = Date.UTC(year, month - 1, day);
  return Number.isNaN(t) ? null : t;
}

/** Сколько дней осталось до срока: отрицательное — просрочено. */
export function daysLeft(deadline: string | null, today = new Date()): number | null {
  const due = startOfDay(deadline);
  if (due === null) return null;
  // День «сегодня» берём по UTC — так же, как клиент (toISOString().slice(0,10)).
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((due - now) / DAY_MS);
}

export function isOverdue(deadline: string | null, today = new Date()): boolean {
  const d = daysLeft(deadline, today);
  return d !== null && d < 0;
}

/**
 * Прибавить КАЛЕНДАРНЫЕ дни к дате ГГГГ-ММ-ДД (UTC-полночь).
 * Нужно типовому сроку, который не считается в рабочих днях (приложение А9).
 * Кривой вход — RangeError, а не «тихо NaN»: срок уехал бы в 1970 год.
 */
export function addCalendarDays(fromIso: string, days: number): string {
  const start = startOfDay(fromIso);
  if (start === null) throw new RangeError("Ожидается дата в формате ГГГГ-ММ-ДД: " + String(fromIso));
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError("Число календарных дней должно быть целым и неотрицательным: " + String(days));
  }
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}
