import {
  DEFAULT_NUMBERING_RULES,
  canOpenPeriod,
  isPeriodClosed,
  nextNumber,
  periodKey,
  previousPeriodKey,
  renderNumber,
  ruleForStream
} from "./numbering.js";

const incoming = ruleForStream(DEFAULT_NUMBERING_RULES, "incoming");
const outgoing = ruleForStream(DEFAULT_NUMBERING_RULES, "outgoing");

describe("формат номера", () => {
  // Заказчик: «формат номера вх{порядковый номер}», без ведущих нулей.
  test("входящие нумеруются как вх1, вх12", () => {
    expect(renderNumber(incoming, "2026", 1)).toBe("вх1");
    expect(renderNumber(incoming, "2026", 12)).toBe("вх12");
  });

  test("у исходящих свой префикс", () => {
    expect(renderNumber(outgoing, "2026", 1)).toBe("исх1");
  });

  test("шаблон может включать год", () => {
    const rule = { ...incoming, template: "{prefix}-{year}-{n}" };
    expect(renderNumber(rule, "2026", 7)).toBe("вх-2026-7");
  });

  test("префикс не ломает подстановку", () => {
    expect(renderNumber({ ...incoming, prefix: "вх." }, "2026", 3)).toBe("вх.3");
  });
});

describe("период счётчика", () => {
  test("счётчик привязан к году", () => {
    expect(periodKey(new Date("2026-12-31T23:00:00"), "year")).toBe("2026");
    expect(periodKey(new Date("2027-01-01T00:10:00"), "year")).toBe("2027");
  });

  test("непрерывная нумерация идёт вне годов", () => {
    expect(periodKey(new Date("2027-01-01T00:10:00"), "never")).toBe("all");
    expect(previousPeriodKey("all")).toBeNull();
  });

  test("предыдущий период вычисляется", () => {
    expect(previousPeriodKey("2027")).toBe("2026");
  });

  test("номер продолжается или начинается с единицы", () => {
    expect(nextNumber(null)).toBe(1);
    expect(nextNumber(41)).toBe(42);
  });
});

describe("закрытие года архивом", () => {
  test("пустой журнал — любой год открывается", () => {
    expect(canOpenPeriod("2026", { openPeriod: null, archivedPeriods: [] }).ok).toBe(true);
  });

  test("в текущем году работать можно", () => {
    expect(canOpenPeriod("2026", { openPeriod: "2026", archivedPeriods: [] }).ok).toBe(true);
  });

  test("следующий год открывается после выгрузки предыдущего", () => {
    expect(canOpenPeriod("2027", { openPeriod: "2026", archivedPeriods: ["2026"] }).ok).toBe(true);
  });

  // Ключевое требование: без экспорта новый год не открывается.
  test("без выгрузки предыдущего года новый не открыть", () => {
    const gate = canOpenPeriod("2027", { openPeriod: "2026", archivedPeriods: [] });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("2026");
    expect(gate.reason).toContain("архив");
  });

  test("перепрыгнуть год нельзя", () => {
    expect(canOpenPeriod("2028", { openPeriod: "2026", archivedPeriods: ["2026"] }).ok).toBe(false);
  });

  test("закрытый год заново не открывается", () => {
    expect(canOpenPeriod("2026", { openPeriod: "2027", archivedPeriods: ["2026"] }).ok).toBe(false);
  });

  test("год считается закрытым только при наличии выгрузки", () => {
    expect(isPeriodClosed("2026", ["2026"])).toBe(true);
    expect(isPeriodClosed("2027", ["2026"])).toBe(false);
  });
});
