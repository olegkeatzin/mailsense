import { daysLeft, isOverdue } from "./deadlines.js";
import { companyDayIso } from "./companyDay.js";

/**
 * То же мгновение, но пояс UTC: день предприятия другой — значит «сегодня» действительно
 * зависит от пояса предприятия, а не от UTC «по умолчанию». Пояс задаётся явно.
 */
const UTC = "UTC";
// 2026-10-08 00:30 МСК = 2026-10-07 21:30 UTC.
const AFTER_MIDNIGHT_MSK = new Date("2026-10-07T21:30:00Z");

describe("UTC: то же мгновение — ещё 7 октября", () => {
  test("день предприятия берётся из пояса процесса, а не из UTC-константы", () => {
    expect(companyDayIso(AFTER_MIDNIGHT_MSK, UTC)).toBe("2026-10-07");
    expect(companyDayIso(AFTER_MIDNIGHT_MSK, "Europe/Moscow")).toBe("2026-10-08");
  });

  test("для UTC-пояса срок 7 октября ещё не просрочен", () => {
    const todayUtc = companyDayIso(AFTER_MIDNIGHT_MSK, UTC);

    expect(daysLeft("2026-10-07", todayUtc)).toBe(0);
    expect(isOverdue("2026-10-07", todayUtc)).toBe(false);
    expect(daysLeft("2026-10-08", todayUtc)).toBe(1);
  });
});
