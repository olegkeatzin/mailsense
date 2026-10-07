import { addCalendarDays, daysLeft, isOverdue } from "./deadlines.js";
import { companyDayIso, companyDayStart, companyTimeZone } from "./companyDay.js";
import { todayIso } from "./journal.js";

/**
 * Границы суток в поясе предприятия (T47), пояс задаётся ЯВНО — тест не зависит от машины.
 *
 * ⚠️ Почему пояс параметром, а не через process.env.TZ: смена TZ в уже запущенном процессе
 * применяется не везде (на Windows пояс кэшируется), и тогда тест «проходил» бы в поясе хоста.
 */
const MSK = "Europe/Moscow";
// 2026-10-08 00:30 МСК = 2026-10-07 21:30 UTC: после местной полуночи, по UTC ещё вчера.
const AFTER_MIDNIGHT_MSK = new Date("2026-10-07T21:30:00Z");
// 2026-10-07 23:50 МСК = 2026-10-07 20:50 UTC.
const LATE_EVENING_MSK = new Date("2026-10-07T20:50:00Z");

describe("МСК: день предприятия — по поясу, а не по UTC", () => {
  test("после местной полуночи (00:30 МСК) день уже 8 октября", () => {
    expect(companyDayIso(AFTER_MIDNIGHT_MSK, MSK)).toBe("2026-10-08");
    expect(companyDayStart(AFTER_MIDNIGHT_MSK, MSK)).toBe(Date.UTC(2026, 9, 8));
  });

  test("вчерашний срок после местной полуночи уже ПРОСРОЧЕН (дефект T47)", () => {
    const todayMsk = companyDayIso(AFTER_MIDNIGHT_MSK, MSK);

    expect(daysLeft("2026-10-07", todayMsk)).toBe(-1);
    expect(isOverdue("2026-10-07", todayMsk)).toBe(true);
    expect(daysLeft("2026-10-08", todayMsk)).toBe(0);
    // Прежнее поведение — день по UTC — давало здесь 0: «срок сегодня» на просроченном.
    expect(daysLeft("2026-10-07", companyDayIso(AFTER_MIDNIGHT_MSK, "UTC"))).toBe(0);
  });

  test("в 23:50 местного срок на завтра — не сегодня", () => {
    const todayMsk = companyDayIso(LATE_EVENING_MSK, MSK);

    expect(todayMsk).toBe("2026-10-07");
    expect(daysLeft("2026-10-08", todayMsk)).toBe(1);
    expect(daysLeft("2026-10-07", todayMsk)).toBe(0);
    expect(isOverdue("2026-10-07", todayMsk)).toBe(false);
  });

  test("журнал считает день тем же правилом, что и сроки", () => {
    // Дата регистрации и «срок сегодня» не должны разъезжаться на границе суток.
    expect(todayIso(AFTER_MIDNIGHT_MSK)).toBe(companyDayIso(AFTER_MIDNIGHT_MSK));
  });

  test("по умолчанию пояс берётся у процесса (TZ контейнера), а не у UTC", () => {
    expect(companyDayIso(AFTER_MIDNIGHT_MSK)).toBe(companyDayIso(AFTER_MIDNIGHT_MSK, companyTimeZone()));
    expect(companyTimeZone().length).toBeGreaterThan(0);
  });

  test("арифметика суток не зависит от переходов времени", () => {
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCalendarDays("2026-10-07", 3)).toBe("2026-10-10");
  });
});
