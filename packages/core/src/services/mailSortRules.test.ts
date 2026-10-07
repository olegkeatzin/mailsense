import {
  matchSortRules,
  validateSortRule,
  type MailSortRule,
  type MailSortInput,
} from "./mailSortRules.js";

/**
 * Правила автосортировки: маршрутизация и подсветка писем, НЕ авторегистрация.
 * Здесь ошибка тихая и потому опасная: правило, которое «ловит всю почту»,
 * или метка, которая пропала из-за регистра, выглядят как рабочий интерфейс.
 */

/** Правило с дефолтами: тест задаёт только то, что проверяет. */
function makeRule(over: Partial<MailSortRule> = {}): MailSortRule {
  return {
    id: "rule-1",
    name: "Правило",
    isActive: true,
    sortOrder: 10,
    matchFrom: "",
    matchTo: "",
    matchSubject: "",
    label: "",
    priority: null,
    note: "",
    ...over,
  };
}

describe("validateSortRule", () => {
  it("принимает правило, у которого непустой хотя бы один матчер", () => {
    expect(validateSortRule(makeRule({ matchSubject: "счёт" }))).toEqual({ ok: true, errors: [] });
    expect(validateSortRule(makeRule({ matchFrom: "иванов" })).ok).toBe(true);
    expect(validateSortRule(makeRule({ matchTo: "office@example.com" })).ok).toBe(true);
  });

  it("отклоняет правило, у которого все три матчера пустые (оно ловит всю почту)", () => {
    const res = validateSortRule(makeRule());
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/матчер/i);
  });

  it("считает пробелы и табы пустым матчером", () => {
    const res = validateSortRule(makeRule({ matchFrom: "   ", matchTo: "\t", matchSubject: "" }));
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/матчер/i);
  });

  it("отклоняет пустой объект и null, не падая", () => {
    expect(validateSortRule({}).ok).toBe(false);
    expect(validateSortRule(null as unknown as Partial<MailSortRule>).ok).toBe(false);
    expect(validateSortRule(undefined as unknown as Partial<MailSortRule>).ok).toBe(false);
  });

  it("держит границы длин ровно на пределе: 120/200/40/200", () => {
    const ok = validateSortRule(
      makeRule({
        name: "н".repeat(120),
        matchFrom: "ф".repeat(200),
        matchTo: "т".repeat(200),
        matchSubject: "с".repeat(200),
        label: "м".repeat(40),
        note: "п".repeat(200),
      })
    );
    expect(ok).toEqual({ ok: true, errors: [] });

    const bad = validateSortRule(
      makeRule({
        name: "н".repeat(121),
        matchFrom: "ф".repeat(201),
        matchTo: "т".repeat(201),
        matchSubject: "с".repeat(201),
        label: "м".repeat(41),
        note: "п".repeat(201),
      })
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(6); // каждое поле проверено отдельно
    const all = bad.errors.join(" | ");
    expect(all).toContain("120");
    expect(all).toContain("200");
    expect(all).toContain("40");
  });

  it("принимает priority 1..5 и пустой priority", () => {
    for (const p of [1, 2, 3, 4, 5]) {
      expect(validateSortRule(makeRule({ matchSubject: "x", priority: p })).ok).toBe(true);
    }
    expect(validateSortRule(makeRule({ matchSubject: "x", priority: null })).ok).toBe(true);
    const { priority: _omitted, ...withoutPriority } = makeRule({ matchSubject: "x" });
    expect(validateSortRule(withoutPriority).ok).toBe(true);
  });

  it("отклоняет priority вне 1..5 и нецелый", () => {
    for (const p of [0, 6, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = validateSortRule(makeRule({ matchSubject: "x", priority: p as number }));
      expect(res.ok).toBe(false);
      expect(res.errors.join(" ")).toMatch(/приоритет/i);
    }
  });

  it("отклоняет priority, пришедший строкой (JSON с клиента)", () => {
    const res = validateSortRule(makeRule({ matchSubject: "x", priority: "3" as unknown as number }));
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/приоритет/i);
  });

  it("возвращает понятные русские тексты ошибок", () => {
    const res = validateSortRule(makeRule({ name: "н".repeat(121), matchSubject: "счёт", priority: 9 }));
    expect(res.errors.length).toBe(2); // только длина имени и приоритет
    for (const e of res.errors) {
      expect(e.trim()).not.toBe("");
      expect(e).toMatch(/[а-яё]/i);
    }
  });
});

describe("matchSortRules — совпадение", () => {
  it("находит кириллицу независимо от регистра", () => {
    const res = matchSortRules(
      [makeRule({ id: "r", matchFrom: "иВаНоВ" })],
      { from: "Иванов И.И. <ivanov@example.com>", to: null, subject: null }
    );
    expect(res.matched).toBe(true);
    expect(res.ruleIds).toEqual(["r"]);
  });

  it("находит латиницу независимо от регистра (без SQL lower())", () => {
    const res = matchSortRules(
      [makeRule({ id: "r", matchTo: "@EXAMPLE.COM" })],
      { from: null, to: "office@example.com", subject: null }
    );
    expect(res.matched).toBe(true);
    expect(res.ruleIds).toEqual(["r"]);
  });

  it("ищет подстроку в теме письма", () => {
    const res = matchSortRules(
      [makeRule({ id: "r", matchSubject: "счёт" })],
      { from: null, to: null, subject: "Оплата по СЧЁТу №5" }
    );
    expect(res.matched).toBe(true);
  });

  it("пустой матчер означает «любой», проверяются только непустые", () => {
    const rules = [makeRule({ id: "r", matchTo: "суд" })];
    expect(matchSortRules(rules, { from: null, to: "СУД №2 Москва", subject: null }).matched).toBe(true);
    expect(matchSortRules(rules, { from: "кто-то", to: "бухгалтерия", subject: "Приказ" }).matched).toBe(false);
  });

  it("матчер из одних пробелов — тоже «любой», а не поиск пробелов", () => {
    const res = matchSortRules(
      [makeRule({ id: "r", matchFrom: "   ", matchSubject: "счёт" })],
      { from: "кто угодно <x@y.z>", to: null, subject: "Счёт №5" }
    );
    expect(res.matched).toBe(true);
    expect(res.ruleIds).toEqual(["r"]);
  });

  it("требует совпадения ВСЕХ непустых матчеров", () => {
    const rules = [makeRule({ id: "r", matchFrom: "иванов", matchTo: "office", matchSubject: "счёт" })];
    expect(
      matchSortRules(rules, { from: "Иванов", to: "office@example.com", subject: "Счёт №5" }).matched
    ).toBe(true);
    expect(matchSortRules(rules, { from: "Иванов", to: "office@example.com", subject: "Приказ" }).matched).toBe(
      false
    );
    expect(matchSortRules(rules, { from: "Петров", to: "office@example.com", subject: "Счёт №5" }).matched).toBe(
      false
    );
  });

  it("не участвует правило, у которого все три матчера пустые", () => {
    const alone = matchSortRules([makeRule({ id: "empty" })], {
      from: "кто угодно",
      to: "office@example.com",
      subject: "любое письмо",
    });
    expect(alone).toEqual({ matched: false, labels: [], notes: [], priority: null, ruleIds: [] });

    const mixed = matchSortRules(
      [makeRule({ id: "empty" }), makeRule({ id: "real", matchSubject: "счёт" })],
      { from: null, to: null, subject: "Счёт №5" }
    );
    expect(mixed.ruleIds).toEqual(["real"]);
  });

  it("игнорирует неактивные правила", () => {
    const res = matchSortRules(
      [
        makeRule({ id: "off", isActive: false, matchSubject: "счёт" }),
        makeRule({ id: "on", isActive: true, matchSubject: "счёт" }),
      ],
      { from: null, to: null, subject: "Счёт №5" }
    );
    expect(res.ruleIds).toEqual(["on"]);
  });

  it("применяет правила в порядке sortOrder ASC, затем id", () => {
    // id намеренно не совпадают с sortOrder: иначе тест не заметил бы игнор sortOrder.
    const rules = [
      makeRule({ id: "z", sortOrder: 10, matchSubject: "счёт" }),
      makeRule({ id: "m", sortOrder: 20, matchSubject: "счёт" }),
      makeRule({ id: "b", sortOrder: 20, matchSubject: "счёт" }),
      makeRule({ id: "a", sortOrder: 30, matchSubject: "счёт" }),
    ];
    const res = matchSortRules(rules, { from: null, to: null, subject: "Счёт" });
    expect(res.ruleIds).toEqual(["z", "b", "m", "a"]); // sortOrder ASC, при равенстве — id
  });

  it("не мутирует входной массив правил", () => {
    const rules = [
      makeRule({ id: "c", sortOrder: 20, matchSubject: "счёт" }),
      makeRule({ id: "a", sortOrder: 10, matchSubject: "счёт" }),
    ];
    const before = rules.map((r) => r.id);
    matchSortRules(rules, { from: null, to: null, subject: "Счёт" });
    expect(rules.map((r) => r.id)).toEqual(before);
  });

  it("не падает на отсутствующих и нестроковых полях письма", () => {
    const rules = [makeRule({ id: "r", matchSubject: "приказ" })];
    expect(matchSortRules(rules, {}).matched).toBe(false);
    expect(matchSortRules(rules, { from: null, to: undefined, subject: null }).matched).toBe(false);
    expect(
      matchSortRules(rules, { from: 42 as unknown as string, to: null, subject: null }).matched
    ).toBe(false);
  });

  it("на пустом списке правил возвращает пустой результат", () => {
    expect(matchSortRules([], { from: "a", to: "b", subject: "c" })).toEqual({
      matched: false,
      labels: [],
      notes: [],
      priority: null,
      ruleIds: [],
    });
  });
});

describe("matchSortRules — priority, метки и подсказки", () => {
  it("priority результата — максимум среди сработавших (больше — важнее)", () => {
    const rules = [
      makeRule({ id: "a", matchSubject: "счёт", priority: null, sortOrder: 1 }),
      makeRule({ id: "b", matchSubject: "счёт", priority: 2, sortOrder: 2 }),
      makeRule({ id: "c", matchSubject: "счёт", priority: 5, sortOrder: 3 }),
      makeRule({ id: "d", matchSubject: "счёт", priority: 3, sortOrder: 4 }),
    ];
    expect(matchSortRules(rules, { from: null, to: null, subject: "Счёт" }).priority).toBe(5);
  });

  it("priority = null, если ни одно сработавшее правило не задаёт приоритет", () => {
    const rules = [makeRule({ id: "a", matchSubject: "счёт", priority: null })];
    expect(matchSortRules(rules, { from: null, to: null, subject: "Счёт" }).priority).toBeNull();
  });

  it("не тащит в приоритет испорченное значение из базы (вне 1..5)", () => {
    const rules = [
      makeRule({ id: "bad", matchSubject: "счёт", priority: 9 as number, sortOrder: 1 }),
      makeRule({ id: "good", matchSubject: "счёт", priority: 4, sortOrder: 2 }),
    ];
    expect(matchSortRules(rules, { from: null, to: null, subject: "Счёт" }).priority).toBe(4);

    const onlyBad = [makeRule({ id: "bad", matchSubject: "счёт", priority: 0 as number })];
    expect(matchSortRules(onlyBad, { from: null, to: null, subject: "Счёт" }).priority).toBeNull();
  });

  it("метки идут в порядке применения, без дублей и без лишних пробелов", () => {
    const rules = [
      makeRule({ id: "z", sortOrder: 1, matchSubject: "счёт", label: "  Срочно  " }),
      makeRule({ id: "b", sortOrder: 2, matchSubject: "счёт", label: "Срочно" }),
      makeRule({ id: "a", sortOrder: 2, matchSubject: "счёт", label: "Договор" }),
      makeRule({ id: "m", sortOrder: 3, matchSubject: "счёт", label: "   " }),
    ];
    const res = matchSortRules(rules, { from: null, to: null, subject: "Счёт" });
    expect(res.labels).toEqual(["Срочно", "Договор"]);
  });

  it("подсказки (notes) идут в порядке применения, пустые не попадают", () => {
    const rules = [
      makeRule({ id: "a", sortOrder: 1, matchSubject: "счёт", note: "Проверить реквизиты" }),
      makeRule({ id: "b", sortOrder: 2, matchSubject: "счёт", note: "" }),
      makeRule({ id: "c", sortOrder: 3, matchSubject: "счёт", note: "Зарегистрировать в журнале" }),
    ];
    const res = matchSortRules(rules, { from: null, to: null, subject: "Счёт" });
    expect(res.notes).toEqual(["Проверить реквизиты", "Зарегистрировать в журнале"]);
  });

  it("matched = false и пустые поля, когда ничего не сработало", () => {
    const res = matchSortRules(
      [makeRule({ id: "a", matchSubject: "счёт", label: "Срочно", priority: 5 })],
      { from: null, to: null, subject: "Приказ" }
    );
    expect(res).toEqual({ matched: false, labels: [], notes: [], priority: null, ruleIds: [] });
  });
});
