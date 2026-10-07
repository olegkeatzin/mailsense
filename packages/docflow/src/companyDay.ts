/**
 * «День предприятия» (T47).
 *
 * ⚠️ День считается по ЧАСОВОМУ ПОЯСУ ПРЕДПРИЯТИЯ (TZ процесса/контейнера), а не по UTC.
 * Иначе для Калуги (МСК, UTC+3) граница суток сдвинута на 03:00: с 00:00 до 03:00 МСК вчерашний
 * срок показывался бы как «срок сегодня», а «просрочено» приходило бы на три часа позже — ровно
 * в те часы, когда аппарат разбирает почту следующего дня.
 *
 * Требование к развёртыванию: день предприятия задаёт TZ контейнера
 * (`TZ=Europe/Moscow` в docker/docker-compose.yml). Если TZ не задан — берётся пояс хоста.
 *
 * Пояс передаётся параметром (по умолчанию — пояс процесса): в тестах это позволяет задать пояс
 * ЯВНО и не зависеть от машины, ведь смена TZ в уже запущенном процессе применяется не везде.
 * Арифметика дней не зависит от переходов времени: метка дня — UTC-полночь календарной даты,
 * поэтому разница меток всегда целое число суток.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Пояс предприятия: TZ процесса (контейнера), иначе пояс хоста. */
export function companyTimeZone(): string {
  const fromEnv = (process.env.TZ ?? "").trim();
  if (fromEnv) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: fromEnv });
      return fromEnv;
    } catch {
      // POSIX-строка вида MSK-3 в Intl не годится — берём пояс хоста, лишь бы не падать.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  formatters.set(zone, created);
  return created;
}

/**
 * День указанного мгновения в поясе предприятия, ГГГГ-ММ-ДД (en-CA даёт ровно этот формат).
 * ЕДИНСТВЕННОЕ место, где решается, какой сейчас день: журнал и сроки обязаны совпадать.
 */
export function companyDayIso(now: Date = new Date(), zone: string = companyTimeZone()): string {
  return formatterFor(zone).format(now);
}

/**
 * Начало дня предприятия как метка UTC-полночи этой календарной даты.
 * Нужна только для календарной арифметики: вычитание таких меток даёт ровно целые сутки.
 */
export function companyDayStart(now: Date = new Date(), zone: string = companyTimeZone()): number {
  const [year, month, day] = companyDayIso(now, zone).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}
