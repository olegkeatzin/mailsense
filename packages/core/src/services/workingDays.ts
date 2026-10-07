/**
 * Рабочие дни и сроки поручений (контракт этапа 5, §5).
 *
 * Считаем в UTC-полночи по строке `YYYY-MM-DD`: часовые пояса и переход на летнее
 * время не должны сдвигать срок на день. Локальные `new Date("2026-01-05")` и
 * `toISOString()` для разбора не используем осознанно — это источник «плавающих» дат.
 *
 * Регулярных выражений нет: формат проверяем по символам.
 */

/** Максимум рабочих дней на один срок: абсурдный вход не должен вешать цикл. */
const MAX_WORKING_DAYS = 100_000;

const MS_PER_DAY = 86_400_000;

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Разбирает `YYYY-MM-DD` в UTC-полночь (мс). Всё остальное — RangeError:
 * «тихо NaN» здесь означал бы срок, уехавший в 1970 год.
 */
function parseDay(value: unknown, what: string): number {
  if (typeof value !== "string") {
    throw new RangeError(`${what}: ожидается дата в формате YYYY-MM-DD, получено ${JSON.stringify(value)}`);
  }
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") {
    throw new RangeError(`${what}: ожидается дата в формате YYYY-MM-DD, получено «${value}»`);
  }
  for (let i = 0; i < value.length; i++) {
    if (i === 4 || i === 7) continue;
    if (!isDigitCode(value.charCodeAt(i))) {
      throw new RangeError(`${what}: ожидается дата в формате YYYY-MM-DD, получено «${value}»`);
    }
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  // setUTCFullYear, а не Date.UTC: Date.UTC(26, ...) молча превращает год в 1926.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  const ts = date.getTime();
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`${what}: нет такой даты — «${value}»`);
  }
  return ts;
}

/** Форматирует UTC-полночь обратно в `YYYY-MM-DD`. */
function formatDay(ts: number): string {
  const date = new Date(ts);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Праздники из настроек приводим к множеству UTC-полночей.
 * Мусор в списке — RangeError: молча пропущенный праздник сдвигает срок, а это
 * ошибка, которую потом ищут по документу.
 */
function holidaySet(holidays: string[] | undefined): Set<number> {
  const set = new Set<number>();
  if (holidays === undefined || holidays === null) return set;
  if (!Array.isArray(holidays)) {
    throw new RangeError("Праздники: ожидается список дат в формате YYYY-MM-DD");
  }
  for (const holiday of holidays) {
    set.add(parseDay(holiday, "Праздник"));
  }
  return set;
}

/** Рабочий ли день по UTC-полночи: пн–пт и не праздник. */
function isWorkingTs(ts: number, holidays: Set<number>): boolean {
  const weekday = new Date(ts).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.has(ts);
}

/** Выходной (сб/вс) или праздник. Кривая дата → RangeError. */
export function isWorkingDay(iso: string, holidays?: string[]): boolean {
  const ts = parseDay(iso, "Дата");
  return isWorkingTs(ts, holidaySet(holidays));
}

/**
 * Число рабочих дней в интервале `(from, to]` — полуинтервал выбран сознательно:
 * срок «сегодня» даёт 0 дней (как `daysLeft === 0` в §3), а
 * `countWorkingDays(from, addWorkingDays(from, n)) === n`.
 * Если `to < from`, результат отрицательный (просрочка), а не ноль.
 */
export function countWorkingDays(fromIso: string, toIso: string, holidays?: string[]): number {
  const from = parseDay(fromIso, "Начало интервала");
  const to = parseDay(toIso, "Конец интервала");
  if (from === to) return 0;

  const holidaysTs = holidaySet(holidays);
  const forward = to > from;
  const step = forward ? MS_PER_DAY : -MS_PER_DAY;
  let count = 0;
  for (let ts = from + step; forward ? ts <= to : ts >= to; ts += step) {
    if (isWorkingTs(ts, holidaysTs)) count++;
  }
  return forward ? count : -count;
}

/**
 * Срок «через N рабочих дней». Отсчёт начинается со СЛЕДУЮЩЕГО дня после `fromIso`.
 * `days = 0` — «сегодня»: `fromIso`, если он рабочий, иначе ближайший рабочий день вперёд.
 */
export function addWorkingDays(fromIso: string, days: number, holidays?: string[]): string {
  if (typeof days !== "number" || !Number.isInteger(days)) {
    throw new RangeError(`days: ожидается целое число рабочих дней, получено ${JSON.stringify(days)}`);
  }
  if (days < 0) {
    throw new RangeError(`days: срок не может быть отрицательным (${days}) — ожидается 0 или больше`);
  }
  if (days > MAX_WORKING_DAYS) {
    throw new RangeError(`days: слишком большой срок (${days}), максимум ${MAX_WORKING_DAYS} рабочих дней`);
  }

  const from = parseDay(fromIso, "Начало отсчёта");
  const holidaysTs = holidaySet(holidays);

  if (days === 0) {
    let ts = from;
    while (!isWorkingTs(ts, holidaysTs)) ts += MS_PER_DAY;
    return formatDay(ts);
  }

  let remaining = days;
  let ts = from;
  while (remaining > 0) {
    ts += MS_PER_DAY;
    if (isWorkingTs(ts, holidaysTs)) remaining--;
  }
  return formatDay(ts);
}
