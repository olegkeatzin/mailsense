import { addWorkingDays, countWorkingDays, isWorkingDay } from "./workingDays.js";

/**
 * Рабочие дни и сроки. Здесь ошибка не видна глазом: срок, уехавший на день из-за
 * выходного или часового пояса, выглядит как обычная дата. Поэтому календарь
 * зафиксирован в тесте, а не вычисляется по `new Date()` в момент прогона.
 *
 * Календарь января 2026 (UTC): 05 пн, 06 вт, 07 ср, 08 чт, 09 пт, 10 сб, 11 вс, 12 пн.
 */

const NEW_YEAR_HOLIDAYS_2027 = [
  "2027-01-01",
  "2027-01-04",
  "2027-01-05",
  "2027-01-06",
  "2027-01-07",
  "2027-01-08",
];

describe("isWorkingDay", () => {
  it("считает рабочими понедельник–пятницу и выходными субботу-воскресенье", () => {
    for (const day of ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]) {
      expect(isWorkingDay(day, [])).toBe(true);
    }
    expect(isWorkingDay("2026-01-10", [])).toBe(false); // сб
    expect(isWorkingDay("2026-01-11", [])).toBe(false); // вс
  });

  it("праздник в середине недели делает день нерабочим", () => {
    expect(isWorkingDay("2026-01-07", [])).toBe(true);
    expect(isWorkingDay("2026-01-07", ["2026-01-07"])).toBe(false);
  });

  it("праздник в субботу ничего не меняет, пустой список — валидный вход", () => {
    expect(isWorkingDay("2026-01-10", ["2026-01-10"])).toBe(false);
    expect(isWorkingDay("2026-01-07", [])).toBe(true);
    expect(isWorkingDay("2026-01-07", undefined)).toBe(true);
  });

  it("отвергает кривой вход RangeError, а не тихо возвращает NaN-логику", () => {
    const bad = ["2026-1-05", "05.01.2026", "2026-02-30", "2026-13-01", "", "2026-01-05T00:00:00Z", "не дата"];
    for (const value of bad) {
      expect(() => isWorkingDay(value)).toThrow(RangeError);
    }
    expect(() => isWorkingDay(undefined as unknown as string)).toThrow(RangeError);
    expect(() => isWorkingDay(null as unknown as string)).toThrow(RangeError);
    expect(() => isWorkingDay("2026-1-05")).toThrow(/YYYY-MM-DD/);
  });

  it("отвергает мусор в списке праздников, а не считает его рабочим днём", () => {
    expect(() => isWorkingDay("2026-01-06", ["31.12.2026"])).toThrow(RangeError);
    expect(() => countWorkingDays("2026-01-05", "2026-01-09", ["2026-1-7"])).toThrow(RangeError);
    expect(() => addWorkingDays("2026-01-05", 1, ["2026-01-07T00:00:00Z"])).toThrow(RangeError);
  });
});

describe("countWorkingDays", () => {
  it("считает рабочие дни в интервале (from, to]", () => {
    expect(countWorkingDays("2026-01-05", "2026-01-05", [])).toBe(0); // срок сегодня = 0 дней
    expect(countWorkingDays("2026-01-05", "2026-01-06", [])).toBe(1);
    expect(countWorkingDays("2026-01-05", "2026-01-09", [])).toBe(4);
    expect(countWorkingDays("2026-01-09", "2026-01-12", [])).toBe(1); // пт → пн, выходные не в счёт
  });

  it("возвращает 0, если в интервале одни выходные", () => {
    expect(countWorkingDays("2026-01-10", "2026-01-11", [])).toBe(0);
    expect(countWorkingDays("2026-01-09", "2026-01-11", [])).toBe(0);
  });

  it("не считает праздники", () => {
    expect(countWorkingDays("2026-01-05", "2026-01-09", [])).toBe(4);
    expect(countWorkingDays("2026-01-05", "2026-01-09", ["2026-01-07"])).toBe(3);
  });

  it("на обратном интервале даёт отрицательное число, а не ноль", () => {
    expect(countWorkingDays("2026-01-09", "2026-01-05", [])).toBe(-4);
    expect(countWorkingDays("2026-01-12", "2026-01-09", [])).toBe(-1);
  });

  it("согласован с addWorkingDays: сколько прибавили, столько и насчитали", () => {
    const from = "2026-01-05";
    const holidays = ["2026-01-07"];
    for (let n = 0; n <= 10; n++) {
      expect(countWorkingDays(from, addWorkingDays(from, n, holidays), holidays)).toBe(n);
    }
  });

  it("отвергает кривые даты RangeError", () => {
    expect(() => countWorkingDays("2026-01-05", "2026-1-09")).toThrow(RangeError);
    expect(() => countWorkingDays("вчера", "2026-01-09")).toThrow(RangeError);
  });
});

describe("addWorkingDays", () => {
  it("days = 0 на рабочем дне возвращает сам день", () => {
    expect(addWorkingDays("2026-01-05", 0, [])).toBe("2026-01-05");
    expect(addWorkingDays("2026-01-09", 0, [])).toBe("2026-01-09");
  });

  it("days = 0 в выходной даёт ближайший рабочий день вперёд", () => {
    expect(addWorkingDays("2026-01-10", 0, [])).toBe("2026-01-12"); // сб → пн
    expect(addWorkingDays("2026-01-11", 0, [])).toBe("2026-01-12"); // вс → пн
  });

  it("days = 0 в праздник даёт ближайший рабочий день вперёд", () => {
    expect(addWorkingDays("2026-01-07", 0, ["2026-01-07"])).toBe("2026-01-08");
    expect(addWorkingDays("2026-01-07", 0, ["2026-01-07", "2026-01-08"])).toBe("2026-01-09");
  });

  it("отсчёт начинается со СЛЕДУЮЩЕГО дня после from", () => {
    expect(addWorkingDays("2026-01-05", 1, [])).toBe("2026-01-06"); // пн + 1 = вт
    expect(addWorkingDays("2026-01-09", 1, [])).toBe("2026-01-12"); // пт + 1 = пн
    expect(addWorkingDays("2026-01-10", 1, [])).toBe("2026-01-12"); // сб + 1 = пн
  });

  it("перешагивает выходные и праздники", () => {
    // ср 07.01 + 3 рабочих дня, чт 08.01 — праздник: пт 09, пн 12, вт 13
    expect(addWorkingDays("2026-01-07", 3, ["2026-01-08"])).toBe("2026-01-13");
  });

  it("работает на границе года с новогодними праздниками", () => {
    // чт 31.12.2026 + 1 рабочий день = пн 11.01.2027 (01.01–08.01 праздники, 09–10 выходные)
    expect(addWorkingDays("2026-12-31", 1, NEW_YEAR_HOLIDAYS_2027)).toBe("2027-01-11");
    expect(addWorkingDays("2026-12-30", 0, NEW_YEAR_HOLIDAYS_2027)).toBe("2026-12-30"); // ср, рабочий
  });

  it("корректно проходит через смену времени в других странах (считаем в UTC)", () => {
    // 08.03.2026 — воскресенье (в США переход на летнее время): выходной не должен «пропасть»
    expect(isWorkingDay("2026-03-08", [])).toBe(false);
    expect(addWorkingDays("2026-03-06", 1, [])).toBe("2026-03-09"); // пт → пн
  });

  it("возвращает ровно YYYY-MM-DD", () => {
    const out = addWorkingDays("2026-01-05", 40, []);
    expect(out.length).toBe(10);
    expect(out[4]).toBe("-");
    expect(out[7]).toBe("-");
    expect(out.slice(0, 4)).toBe("2026");
  });

  it("отвергает days < 0, нецелые и нечисловые значения RangeError", () => {
    for (const days of [-1, -100]) {
      expect(() => addWorkingDays("2026-01-05", days, [])).toThrow(RangeError);
    }
    for (const days of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addWorkingDays("2026-01-05", days, [])).toThrow(RangeError);
    }
    expect(() => addWorkingDays("2026-01-05", "3" as unknown as number, [])).toThrow(RangeError);
    expect(() => addWorkingDays("2026-01-05", -1, [])).toThrow(/days/);
  });

  it("отвергает абсурдно большой срок вместо бесконечного цикла", () => {
    expect(() => addWorkingDays("2026-01-05", 1_000_000, [])).toThrow(RangeError);
  });

  it("отвергает кривую дату from RangeError", () => {
    expect(() => addWorkingDays("2026-02-30", 1, [])).toThrow(RangeError);
    expect(() => addWorkingDays("", 1, [])).toThrow(RangeError);
  });
});
