/**
 * Безопасность этапа 5 — сводный файл (владелец: security-specialist).
 *
 * Две части:
 *   I.  Чистая логика (без HTTP и базы): ReDoS, кириллица, «бомбы», границы полей,
 *       10^4 правил, рабочие дни. Импорт идёт напрямую из core, минуя мок
 *       "@mailsense/core": проверяется настоящая функция, а не заглушка.
 *   II. HTTP: матрица прав новых маршрутов (§6 контракта), IDOR уведомлений и перечисление
 *       id, 503 без базы, запреты этапа (правило не регистрирует документ и не расходует
 *       номер; уведомления не уходят письмом — Р11/А8).
 *
 * ⚠️ Пакет server подменяет @mailsense/docflow и @mailsense/core: маршруты, middleware прав и
 * порядок объявления путей работают по-настоящему, база — мок. Права ролей берутся настоящие
 * (docflow/src/roles.ts), матчинг правил — настоящий (core/src/services/mailSortRules.ts).
 * Прогон БД не требует, слот на packages/server не нужен (подтверждено Lead'ом 2026-10-07).
 *
 * ⚠️ Границы доказательства: валидация, живущая в СЛОЕ ДАННЫХ docflow (например,
 * validateHolidays), этим файлом не проверяется — она за моком. Её красный тест принадлежит
 * пакету docflow (см. docs/security/stage5-review.md, D-1). Здесь проверяется, что отказ слоя
 * данных доходит до клиента правильным кодом (PA6).
 */
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";
import {
  matchSortRules,
  validateSortRule,
  type MailSortRule
} from "../../core/src/services/mailSortRules";
import { addWorkingDays, countWorkingDays, isWorkingDay } from "../../core/src/services/workingDays";

jest.mock("@mailsense/core", () => {
  const m = require("./testing/mocks.js").coreMockModule() as Record<string, unknown>;
  // Матчинг правил обязан быть НАСТОЯЩИМ: иначе поля sortLabels/sortPriority в очереди
  // входящих и запрет «правило не создаёт документ» проверялись бы на заглушке.
  const real = jest.requireActual("../../core/src/services/mailSortRules");
  m.matchSortRules = real.matchSortRules;
  // Обёртка-шпион: поведение настоящее, но тест может проверить, что сервер зовёт
  // канонический валидатор §5, а не свою вторую реализацию границ.
  m.validateSortRule = jest.fn(real.validateSortRule);
  return m;
});

jest.mock("@mailsense/docflow", () => {
  const m = require("./testing/mocks.js").docflowMockModule() as Record<string, unknown>;
  const generic = () => ({
    items: [],
    rule: null,
    ok: true,
    updated: 0,
    unread: 0,
    total: 0,
    matched: 0,
    samples: [],
    enabled: true
  });
  // Уведомления: имена экспортов — из docflow/src/notifications.ts.
  m.listNotifications = jest.fn(async () => ({ items: [], unread: 0, total: 0, enabled: true }));
  m.countUnreadNotifications = jest.fn(async () => 0);
  m.markNotificationRead = jest.fn(async () => ({ ok: true, unread: 0 }));
  m.markAllNotificationsRead = jest.fn(async () => 0);
  m.materializeDeadlineNotificationsSafe = jest.fn(async () => undefined);
  m.getNotificationSettings = jest.fn(async () => ({
    enabled: true,
    dueSoonDays: 3,
    workdayDeadlines: true,
    holidays: [],
    variables: [],
    templates: []
  }));
  m.saveNotificationSettings = jest.fn(async () => ({
    enabled: true,
    dueSoonDays: 3,
    workdayDeadlines: true,
    holidays: [],
    variables: [],
    templates: []
  }));
  m.notificationsEnabled = jest.fn(async () => true);
  // Правила сортировки и справочник сроков: маршруты ждут МАССИВЫ — нейтральный объект
  // из Proxy здесь дал бы 500, поэтому заглушки объявлены явно.
  const ruleRecord = {
    id: "rule-1",
    name: "Приказ",
    isActive: true,
    sortOrder: 0,
    matchFrom: "",
    matchTo: "",
    matchSubject: "приказ",
    label: "",
    priority: null,
    note: ""
  };
  m.listSortRules = jest.fn(async () => []);
  m.getSortRule = jest.fn(async (id: string) => (id === "rule-1" ? { ...ruleRecord } : null));
  m.saveSortRule = jest.fn(async (input: Record<string, unknown>) => ({ ...ruleRecord, ...input }));
  m.deleteSortRule = jest.fn(async () => true);
  m.listDeadlinePresets = jest.fn(async () => []);
  m.addCalendarDays = jest.fn((from: string) => from);
  // Любой ещё не объявленный экспорт этапа 5 (CRUD правил сортировки) не должен ломать
  // маршрут: возвращаем нейтральный объект, а поведение задаёт конкретный тест.
  return new Proxy(m, {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (typeof prop !== "string") return undefined;
      if (!(prop in target)) (target as Record<string, unknown>)[prop] = jest.fn(async () => generic());
      return (target as Record<string, unknown>)[prop];
    }
  });
});

/** Правило с разумными значениями по умолчанию: тест переопределяет нужное поле. */
function rule(patch: Partial<MailSortRule> = {}): MailSortRule {
  return {
    id: "r1",
    name: "Правило",
    isActive: true,
    sortOrder: 0,
    matchFrom: "",
    matchTo: "",
    matchSubject: "приказ",
    label: "",
    priority: null,
    note: "",
    ...patch
  };
}

/** Замер времени в миллисекундах. */
function ms(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("этап 5 · правила сортировки: ReDoS и строки-«бомбы»", () => {
  it("метасимволы регулярных выражений трактуются буквально (регулярок в матчинге нет)", () => {
    // Если бы матчер компилировался в RegExp, ".*" совпал бы с любой темой, а "a+b" — с "aaab".
    const anyRegex = matchSortRules([rule({ matchSubject: ".*" })], { subject: "Совершенно другая тема" });
    expect(anyRegex.matched).toBe(false);

    const plusRegex = matchSortRules([rule({ matchSubject: "a+b" })], { subject: "aaab" });
    expect(plusRegex.matched).toBe(false);

    const altRegex = matchSortRules([rule({ matchSubject: "приказ|распоряжение" })], { subject: "распоряжение №1" });
    expect(altRegex.matched).toBe(false);

    // А буквальное совпадение с метасимволами внутри текста — работает.
    const literal = matchSortRules([rule({ matchSubject: ".*" })], { subject: "файл .* в теме" });
    expect(literal.matched).toBe(true);
  });

  it("«бомба» в теме (50 000 символов) не приводит к катастрофическому времени", () => {
    const haystack = "a".repeat(50_000) + "!";
    const elapsed = ms(() => {
      // Матчер, который почти совпадает и в конце обрывается: худший случай для наивного поиска.
      matchSortRules([rule({ matchSubject: "a".repeat(199) + "!" })], { subject: haystack });
      // И матчер, который не совпадает вовсе.
      matchSortRules([rule({ matchSubject: "zzz" })], { subject: haystack });
    });
    expect(elapsed).toBeLessThan(500);
  });

  it("длинный матчер (200 символов, предел контракта) не взрывает поиск", () => {
    const matcher = "и".repeat(200);
    const subject = ("и".repeat(200) + " приказ").repeat(20);
    const elapsed = ms(() => {
      for (let i = 0; i < 100; i++) matchSortRules([rule({ matchSubject: matcher })], { subject });
    });
    expect(elapsed).toBeLessThan(500);
  });
});

describe("этап 5 · правила сортировки: кириллица и регистр", () => {
  it("матчер в нижнем регистре находит кириллицу в любом регистре", () => {
    const m = matchSortRules([rule({ matchSubject: "приказ" })], { subject: "ПРИКАЗ №5 от 07.10.2026" });
    expect(m.matched).toBe(true);
    expect(m.ruleIds).toEqual(["r1"]);
  });

  it("матчер в верхнем регистре находит кириллицу в нижнем", () => {
    // matchSubject пуст: правило проверяет ровно отправителя (пустой матчер = «любой»).
    const m = matchSortRules([rule({ matchFrom: "ИВАНОВ", matchSubject: "" })], {
      from: "Иванов Иван Иванович <ivanov@stand.test>"
    });
    expect(m.matched).toBe(true);
  });

  it("«ё» и «Ё» в кириллице обрабатываются регистронезависимо", () => {
    const m = matchSortRules([rule({ matchSubject: "ёж" })], { subject: "ЁЖИК в тему" });
    expect(m.matched).toBe(true);
  });

  it("матчинг идёт по строке письма, а не по её части в другом регистре", () => {
    const m = matchSortRules([rule({ matchTo: "петрова", matchSubject: "" })], {
      to: "Петрова Мария <petrova@stand.test>"
    });
    expect(m.matched).toBe(true);
  });
});

describe("этап 5 · правила сортировки: пустые матчеры и семантика", () => {
  it("правило без единого матчера невалидно — иначе оно ловит всю почту", () => {
    const verdict = validateSortRule({ name: "Ловим всё", matchFrom: "", matchTo: "", matchSubject: "" });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("матчер");
  });

  it("правило без матчеров не участвует в матчинге, даже если лежит в базе", () => {
    const m = matchSortRules([rule({ matchFrom: "  ", matchTo: "", matchSubject: "" })], {
      from: "кто угодно@example.com",
      subject: "что угодно"
    });
    expect(m.matched).toBe(false);
  });

  it("пустое поле матчера = «любой», непустые должны совпасть все", () => {
    const only = matchSortRules([rule({ matchFrom: "", matchTo: "", matchSubject: "акт" })], { subject: "АКТ сверки" });
    expect(only.matched).toBe(true);

    const both = matchSortRules([rule({ matchFrom: "иванов", matchSubject: "акт" })], {
      from: "Иванов И.И.",
      subject: "АКТ сверки"
    });
    expect(both.matched).toBe(true);

    const mismatch = matchSortRules([rule({ matchFrom: "иванов", matchSubject: "акт" })], {
      from: "Петров П.П.",
      subject: "АКТ сверки"
    });
    expect(mismatch.matched).toBe(false);
  });

  it("неактивные правила игнорируются полностью", () => {
    const m = matchSortRules([rule({ isActive: false, matchSubject: "приказ" })], { subject: "ПРИКАЗ №1" });
    expect(m.matched).toBe(false);
  });

  it("порядок применения: sortOrder ASC, затем id; метки без дублей", () => {
    const rules = [
      rule({ id: "b", sortOrder: 2, matchSubject: "письмо", label: "Позже" }),
      rule({ id: "a", sortOrder: 1, matchSubject: "письмо", label: "Раньше" }),
      rule({ id: "c", sortOrder: 1, matchSubject: "письмо", label: "Раньше" })
    ];
    const m = matchSortRules(rules, { subject: "письмо" });
    // sortOrder 1 — сначала, внутри него по id: a, c, затем b.
    expect(m.ruleIds).toEqual(["a", "c", "b"]);
    // Метки — в порядке применения, без дублей.
    expect(m.labels).toEqual(["Раньше", "Позже"]);
  });

  it("priority результата — максимум среди сработавших", () => {
    const rules = [
      rule({ id: "a", matchSubject: "письмо", priority: 2 }),
      rule({ id: "b", matchSubject: "письмо", priority: 5 }),
      rule({ id: "c", matchSubject: "письмо", priority: null })
    ];
    expect(matchSortRules(rules, { subject: "письмо" }).priority).toBe(5);
    const безПриоритета = matchSortRules([rule({ matchSubject: "письмо", priority: null })], { subject: "письмо" });
    expect(безПриоритета.matched).toBe(true);
    expect(безПриоритета.priority).toBeNull();
  });

  it("приоритет вне 1..5 из испорченной базы не попадает в результат", () => {
    const bad = rule({ matchSubject: "письмо", priority: 99 as unknown as number });
    expect(matchSortRules([bad], { subject: "письмо" }).priority).toBeNull();
  });
});

describe("этап 5 · правила сортировки: границы полей (нельзя залить километры)", () => {
  it("ровно на границах (120/200/40/200) правило валидно", () => {
    const verdict = validateSortRule({
      name: "н".repeat(120),
      matchSubject: "м".repeat(200),
      matchFrom: "",
      matchTo: "",
      label: "л".repeat(40),
      note: "п".repeat(200),
      priority: 5
    });
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("на один символ больше границы — понятная ошибка по каждому полю", () => {
    const verdict = validateSortRule({
      name: "н".repeat(121),
      matchSubject: "м".repeat(201),
      matchFrom: "",
      matchTo: "",
      label: "л".repeat(41),
      note: "п".repeat(201)
    });
    expect(verdict.ok).toBe(false);
    for (const text of ["Название правила", "Матчер «Тема»", "Метка", "Примечание"]) {
      expect(verdict.errors.join(" ")).toContain(text);
    }
  });

  it("приоритет: 0, 6, 1.5, строка «3» — ошибка; 1 и 5 — валидно", () => {
    for (const bad of [0, 6, 1.5, "3"]) {
      const verdict = validateSortRule({ matchSubject: "тема", priority: bad as unknown as number });
      expect(verdict.ok).toBe(false);
      expect(verdict.errors.join(" ")).toContain("Приоритет");
    }
    for (const good of [1, 5, null, undefined]) {
      const verdict = validateSortRule({ matchSubject: "тема", priority: good as number | null | undefined });
      expect(verdict.ok).toBe(true);
    }
  });

  it("нестроковое значение поля — ошибка «ожидается текст», а не молчаливое приведение", () => {
    const verdict = validateSortRule({ matchSubject: 42 as unknown as string, matchFrom: "" });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("ожидается текст");
  });

  it("мусор вместо правила не роняет валидацию", () => {
    expect(validateSortRule(null as unknown as Partial<MailSortRule>).ok).toBe(false);
    expect(validateSortRule(undefined as unknown as Partial<MailSortRule>).ok).toBe(false);
  });
});

describe("этап 5 · правила сортировки: массовость (10^4 правил)", () => {
  it("10 000 правил обрабатываются за линейное время, без квадратичного взрыва", () => {
    const rules: MailSortRule[] = [];
    for (let i = 0; i < 10_000; i++) {
      rules.push(
        rule({
          id: "rule-" + String(i).padStart(5, "0"),
          sortOrder: i,
          // Срабатывает только каждое десятое — остальные отсеиваются на первом матчере.
          matchSubject: i % 10 === 0 ? "приказ" : "нет-такого-текста-" + i,
          label: "метка-" + (i % 7)
        })
      );
    }
    const elapsed = ms(() => {
      const m = matchSortRules(rules, { subject: "ПРИКАЗ №5", from: "a@b.c", to: "d@e.f" });
      expect(m.ruleIds).toHaveLength(1000);
      expect(m.matched).toBe(true);
    });
    // Порог с запасом: важно отсутствие взрыва, а не микросекунды.
    expect(elapsed).toBeLessThan(3000);
  });

  it("10^4 правил с «бомбой» в теме не блокируют поток надолго", () => {
    const subject = "a".repeat(20_000);
    const rules: MailSortRule[] = Array.from({ length: 10_000 }, (_, i) =>
      rule({ id: "r" + i, sortOrder: i, matchSubject: "приказ-" + i })
    );
    const elapsed = ms(() => {
      matchSortRules(rules, { subject });
    });
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("этап 5 · негативный контроль: проверки различают сломанную реализацию", () => {
  // Смысл блока: доказать, что тесты выше НЕ проходят на любом коде. Здесь воспроизведены
  // ровно те дефекты, которые они обязаны ловить. Инъекция в продовый модуль (core) — не моя
  // зона записи, поэтому чувствительность проверяется на эталонных «сломанных» реализациях.

  it("регистрозависимый матчинг (без toLowerCase) не прошёл бы проверки кириллицы", () => {
    const brokenMatch = (haystack: string, matcher: string) => haystack.includes(matcher);
    // Именно то, что утверждают тесты кириллицы: без нормализации регистра совпадения нет.
    expect(brokenMatch("ПРИКАЗ №5", "приказ")).toBe(false);
    expect(brokenMatch("Иванов И.И.", "ИВАНОВ")).toBe(false);
    expect(matchSortRules([rule({ matchSubject: "приказ" })], { subject: "ПРИКАЗ №5" }).matched).toBe(true);
  });

  it("матчинг через RegExp (ReDoS-путь) провалил бы проверку метасимволов", () => {
    const regexMatch = (haystack: string, matcher: string) => new RegExp(matcher).test(haystack);
    // «Сломанная» версия считает ".*" совпадением с любой темой — тест это ловит.
    expect(regexMatch("Совершенно другая тема", ".*")).toBe(true);
    expect(matchSortRules([rule({ matchSubject: ".*" })], { subject: "Совершенно другая тема" }).matched).toBe(false);
    // И альтернация "приказ|распоряжение" в настоящем матчинге не работает как «или».
    expect(matchSortRules([rule({ matchSubject: "приказ|распоряжение" })], { subject: "распоряжение №1" }).matched).toBe(
      false
    );
  });
});

describe("этап 5 · рабочие дни и сроки: кривой вход не превращается в «тихий NaN»", () => {
  // Проверка безопасности ввода: срок управляет напоминаниями и просрочкой. «Тихо NaN»
  // или «1970 год» здесь означало бы уведомление не о том сроке — а это ошибка, которую
  // ищут по документу (rules §4.6: система заведена ради вопроса «кто внёс данные неверно»).

  it("кривой формат даты — RangeError, а не NaN и не 1970 год", () => {
    for (const bad of ["07.10.2026", "2026-10-7", "2026/10/07", "20261007", "", "2026-10-07T00:00:00Z", "2026-13-01", "2026-02-30"]) {
      expect(() => isWorkingDay(bad)).toThrow(RangeError);
    }
    expect(() => isWorkingDay(42 as unknown as string)).toThrow(RangeError);
  });

  it("days: отрицательный, дробный, запредельный и не-число — RangeError", () => {
    for (const bad of [-1, 1.5, 100_001, "3", null, undefined]) {
      expect(() => addWorkingDays("2026-10-07", bad as unknown as number)).toThrow(RangeError);
    }
    // Верхняя граница не должна вешать цикл: абсурдный срок отвергается, а не считается.
    expect(() => addWorkingDays("2026-10-07", 100_000)).not.toThrow();
  });

  it("мусор в списке праздников — RangeError (молча пропущенный праздник сдвигает срок)", () => {
    expect(() => isWorkingDay("2026-10-07", ["не-дата"])).toThrow(RangeError);
    expect(() => isWorkingDay("2026-10-07", "2026-10-07" as unknown as string[])).toThrow(RangeError);
  });

  it("выходные и праздники не считаются рабочими днями, срок уезжает вперёд", () => {
    expect(isWorkingDay("2026-10-10")).toBe(false); // суббота
    expect(isWorkingDay("2026-10-11")).toBe(false); // воскресенье
    expect(isWorkingDay("2026-10-09")).toBe(true); // пятница
    // Пятница + 1 рабочий день с праздником в понедельник → вторник.
    expect(addWorkingDays("2026-10-09", 1, ["2026-10-12"])).toBe("2026-10-13");
    expect(isWorkingDay("2026-10-12", ["2026-10-12"])).toBe(false);
  });

  it("срок «сегодня» не съезжает на выходной и не даёт NaN", () => {
    // Суббота, days = 0 → ближайший рабочий день вперёд (понедельник).
    expect(addWorkingDays("2026-10-10", 0)).toBe("2026-10-12");
    const result = addWorkingDays("2026-10-09", 0);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe("2026-10-09");
  });

  it("countWorkingDays и addWorkingDays согласованы: (from, addWorkingDays(from, n)] = n", () => {
    for (const n of [0, 1, 3, 10]) {
      const from = "2026-10-07";
      const to = addWorkingDays(from, n);
      expect(countWorkingDays(from, to)).toBe(n);
    }
  });

  it("срок «в прошлом» даёт отрицательное число дней, а не ноль", () => {
    expect(countWorkingDays("2026-10-07", "2026-10-01")).toBeLessThan(0);
  });

  it("широкий интервал считается за разумное время (нет неограниченного цикла)", () => {
    const elapsed = ms(() => {
      countWorkingDays("2000-01-01", "2100-01-01");
    });
    expect(elapsed).toBeLessThan(1000);
  });
});

// ==================== II. HTTP: права, IDOR, запреты этапа ====================

const HTTP_ROLES = ["admin", "secretary", "manager", "signer", "executor"] as const;
const httpToken = (role: string) => "stage5:" + role;

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, TestUser>;
};
const mockedCore = core as unknown as Record<string, jest.Mock>;

interface HttpCase {
  /** Что защищаем — формулировка требования. */
  what: string;
  method: string;
  path: string;
  body?: unknown;
  /** Роли, которым действие разрешено; остальным — 403. */
  allowed: readonly string[];
  /** Допустимые коды успеха. */
  ok?: number[];
}

/** Новые маршруты этапа 5 — ровно по §6 контракта (11 штук). */
const STAGE5_ROUTES: HttpCase[] = [
  {
    what: "GET /notifications — свои уведомления: право notifications.view у всех пяти ролей (Q1)",
    method: "GET",
    path: "/api/docflow/notifications",
    allowed: HTTP_ROLES
  },
  {
    what: "GET /notifications/count — дешёвый счётчик для бейджа",
    method: "GET",
    path: "/api/docflow/notifications/count",
    allowed: HTTP_ROLES
  },
  {
    what: "POST /notifications/:id/read — прочтение уведомления",
    method: "POST",
    path: "/api/docflow/notifications/n-1/read",
    allowed: HTTP_ROLES
  },
  {
    what: "POST /notifications/read-all — «прочитать все» только по своим строкам",
    method: "POST",
    path: "/api/docflow/notifications/read-all",
    allowed: HTTP_ROLES
  },
  {
    what: "GET /notifications/settings — настройки уведомлений читает только администратор",
    method: "GET",
    path: "/api/docflow/notifications/settings",
    allowed: ["admin"]
  },
  {
    what: "PUT /notifications/settings — менять настройки уведомлений только администратор",
    method: "PUT",
    path: "/api/docflow/notifications/settings",
    body: { dueSoonDays: 3 },
    allowed: ["admin"]
  },
  {
    what: "GET /sorting/rules — правила сортировки видит только администратор",
    method: "GET",
    path: "/api/docflow/sorting/rules",
    allowed: ["admin"]
  },
  {
    what: "POST /sorting/rules — создавать правила только администратору",
    method: "POST",
    path: "/api/docflow/sorting/rules",
    body: { name: "Приказ", matchSubject: "приказ" },
    allowed: ["admin"],
    ok: [200, 201]
  },
  {
    what: "PATCH /sorting/rules/:id — править правило только администратору",
    method: "PATCH",
    path: "/api/docflow/sorting/rules/rule-1",
    body: { name: "Другое" },
    allowed: ["admin"]
  },
  {
    what: "DELETE /sorting/rules/:id — удалять правило только администратору",
    method: "DELETE",
    path: "/api/docflow/sorting/rules/rule-1",
    allowed: ["admin"]
  },
  {
    what: "POST /sorting/rules/preview — предпросмотр правила только администратору",
    method: "POST",
    path: "/api/docflow/sorting/rules/preview",
    body: { matchSubject: "приказ" },
    allowed: ["admin"]
  }
];

let app: RunningApp;

beforeAll(async () => {
  for (const role of [...HTTP_ROLES, "none"]) {
    mockedDocflow.__sessions.set(httpToken(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("этап 5 · HTTP: матрица «маршрут × роль»", () => {
  for (const route of STAGE5_ROUTES) {
    it(route.what, async () => {
      const failures: string[] = [];
      for (const role of HTTP_ROLES) {
        const res = await request(app.baseUrl, route.method, route.path, {
          token: httpToken(role),
          body: route.body
        });
        const expected = route.allowed.includes(role) ? route.ok ?? [200] : [403];
        if (!expected.includes(res.status)) {
          failures.push(role + ": ждали " + expected.join("/") + ", получили " + res.status + " — " + res.text.slice(0, 120));
        }
      }
      // Пользователь БЕЗ ролей: ни одна роль права не выдала → 403.
      const nobody = await request(app.baseUrl, route.method, route.path, {
        token: httpToken("none"),
        body: route.body
      });
      if (nobody.status !== 403) {
        failures.push("без ролей: ждали 403, получили " + nobody.status + " — " + nobody.text.slice(0, 120));
      }
      // Без сессии — 401 (нужен вход), а не 403 (не хватает прав): клиент различает их.
      const anon = await request(app.baseUrl, route.method, route.path, { body: route.body });
      if (anon.status !== 401) {
        failures.push("без токена: ждали 401, получили " + anon.status + " — " + anon.text.slice(0, 120));
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("этап 5 · HTTP: IDOR и перечисление id уведомлений", () => {
  it("своё → 200, чужое → 404, и маршрут передаёт именно req.user.id", async () => {
    mockedDocflow.markNotificationRead.mockImplementation(async (id: string) =>
      id === "mine" ? { ok: true, unread: 4 } : null
    );

    const own = await request(app.baseUrl, "POST", "/api/docflow/notifications/mine/read", {
      token: httpToken("executor")
    });
    expect(own.status).toBe(200);
    expect(mockedDocflow.markNotificationRead).toHaveBeenCalledWith("mine", "u-executor");

    const foreign = await request(app.baseUrl, "POST", "/api/docflow/notifications/foreign/read", {
      token: httpToken("executor")
    });
    expect(foreign.status).toBe(404);
    expect(mockedDocflow.markNotificationRead).toHaveBeenCalledWith("foreign", "u-executor");
    // Отказ не выдаёт существование чужой записи.
    expect(foreign.text.toLowerCase()).not.toContain("чуж");
  });

  it("чужой и несуществующий id дают ОДИНАКОВЫЙ ответ (перечисление невозможно)", async () => {
    mockedDocflow.markNotificationRead.mockResolvedValue(null);
    const foreign = await request(app.baseUrl, "POST", "/api/docflow/notifications/someone-else/read", {
      token: httpToken("executor")
    });
    const absent = await request(app.baseUrl, "POST", "/api/docflow/notifications/does-not-exist/read", {
      token: httpToken("executor")
    });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.text).toBe(absent.text);
  });

  it("read-all возвращает число своих обновлённых строк и передаёт пользователя сессии", async () => {
    mockedDocflow.markAllNotificationsRead.mockResolvedValue(2);
    const res = await request(app.baseUrl, "POST", "/api/docflow/notifications/read-all", {
      token: httpToken("signer")
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.markAllNotificationsRead).toHaveBeenCalledWith("u-signer");
    const body = res.body as { updated?: number; unread?: number };
    expect(body.updated).toBe(2);
    expect(body.unread).toBe(0);
  });

  it("список и счётчик читают только уведомления пользователя сессии", async () => {
    await request(app.baseUrl, "GET", "/api/docflow/notifications", { token: httpToken("manager") });
    await request(app.baseUrl, "GET", "/api/docflow/notifications/count", { token: httpToken("manager") });
    expect(mockedDocflow.listNotifications).toHaveBeenCalledWith("u-manager", expect.anything());
    expect(mockedDocflow.countUnreadNotifications).toHaveBeenCalledWith("u-manager");
  });

  it("инъекция в :id (кавычки, %, _, 5 КБ) не выполняется и не открывает чужие строки", async () => {
    for (const id of ["%27%20OR%201%3D1--", "%25", "%5F", "0".repeat(5000)]) {
      const res = await request(app.baseUrl, "POST", "/api/docflow/notifications/" + id + "/read", {
        token: httpToken("admin")
      });
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe("этап 5 · HTTP: доступность и лимиты", () => {
  it("без базы документооборота ни один новый маршрут не отвечает данными — 503", async () => {
    mockedDocflow.hasDocflowDb.mockReturnValue(false);
    const failures: string[] = [];
    for (const route of STAGE5_ROUTES) {
      const res = await request(app.baseUrl, route.method, route.path, {
        token: httpToken("admin"),
        body: route.body
      });
      if (res.status !== 503) failures.push(route.method + " " + route.path + ": " + res.status);
    }
    mockedDocflow.hasDocflowDb.mockReturnValue(true);
    expect(failures).toEqual([]);
  });

  it("мусор в limit — 400, а не LIMIT NaN и не выгрузка всей таблицы", async () => {
    const bad = await request(app.baseUrl, "GET", "/api/docflow/notifications?limit=abc", {
      token: httpToken("admin")
    });
    expect(bad.status).toBe(400);

    const huge = await request(app.baseUrl, "GET", "/api/docflow/notifications?limit=1000000000", {
      token: httpToken("admin")
    });
    // Огромный limit не должен доходить до SQL как есть: либо отказ, либо ограничение.
    expect([200, 400]).toContain(huge.status);
  });
});

describe("этап 5 · HTTP: запреты этапа (нумерация, авторегистрация, письма-напоминания)", () => {
  it("проход по ВСЕМ новым маршрутам не создаёт документ и не расходует номер", async () => {
    for (const route of STAGE5_ROUTES) {
      await request(app.baseUrl, route.method, route.path, { token: httpToken("admin"), body: route.body });
    }
    expect(mockedDocflow.registerDocument).not.toHaveBeenCalled();
    expect(mockedDocflow.peekNextNumber).not.toHaveBeenCalled();
  });

  it("очередь входящих с правилами не создаёт документ и не тратит номер", async () => {
    mockedCore.listEmailsWithAnalysis.mockReturnValue([
      {
        id: "e-1",
        accountId: "acc-1",
        subject: "ПРИКАЗ №1",
        from: "Иванов <ivanov@stand.test>",
        date: "2026-10-07T00:00:00.000Z",
        analysisStatus: "done",
        externalNumber: null,
        sendDate: null,
        analysis: { summary: "приказ", priority: 4, tags: [] }
      }
    ]);
    mockedCore.countAttachmentsByEmail.mockReturnValue(new Map());
    mockedDocflow.listRegisteredEmailIds.mockResolvedValue([]);

    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?rulesOnly=1&sort=rules", {
      token: httpToken("secretary")
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.registerDocument).not.toHaveBeenCalled();
    expect(mockedDocflow.peekNextNumber).not.toHaveBeenCalled();
  });

  it("ни один новый маршрут не отправляет письмо (Р11/А8: напоминаний письмом нет)", async () => {
    for (const route of STAGE5_ROUTES) {
      await request(app.baseUrl, route.method, route.path, { token: httpToken("admin"), body: route.body });
    }
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
  });
});

describe("этап 5 · HTTP: очередь входящих и предпросмотр правил (S10, S11)", () => {
  const mail = (id: string, subject: string, date: string) => ({
    id,
    accountId: "acc-1",
    subject,
    from: { name: "Иванов", address: "ivanov@stand.test" },
    to: [{ name: "Аппарат", address: "sec@stand.test" }],
    date,
    analysisStatus: "done",
    externalNumber: null,
    sendDate: null,
    analysis: { summary: subject, priority: 2, tags: [] }
  });

  beforeEach(() => {
    mockedCore.listEmailsWithAnalysis.mockReturnValue([
      mail("e-1", "Обычное письмо", "2026-10-01T00:00:00.000Z"),
      mail("e-2", "ПРИКАЗ №5", "2026-10-05T00:00:00.000Z")
    ]);
    mockedCore.countAttachmentsByEmail.mockReturnValue(new Map());
    mockedDocflow.listRegisteredEmailIds.mockResolvedValue([]);
    mockedDocflow.listSortRules.mockResolvedValue([
      {
        id: "r-1",
        name: "Приказы",
        isActive: true,
        sortOrder: 0,
        matchFrom: "",
        matchTo: "",
        matchSubject: "приказ",
        label: "Приказ",
        priority: 5,
        note: "Подсказка аппарату"
      }
    ]);
  });

  it("S10: по умолчанию порядок очереди НЕ меняется, а поля правил добавлены", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming", {
      token: httpToken("secretary")
    });
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    // Порядок — как отдал ящик (date), а не «умная» пересортировка по правилам.
    expect(items.map((i) => i.emailId)).toEqual(["e-1", "e-2"]);

    const order = items.find((i) => i.emailId === "e-2") as Record<string, unknown>;
    expect(order.sortMatched).toBe(true);
    expect(order.sortLabels).toEqual(["Приказ"]);
    expect(order.sortPriority).toBe(5);
    expect(order.sortNotes).toEqual(["Подсказка аппарату"]);

    const plain = items.find((i) => i.emailId === "e-1") as Record<string, unknown>;
    expect(plain.sortMatched).toBe(false);
    expect(plain.sortLabels).toEqual([]);
    expect(plain.sortPriority).toBeNull();
  });

  it("S10: rulesOnly=1 оставляет только совпавшие письма", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?rulesOnly=1", {
      token: httpToken("secretary")
    });
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.emailId)).toEqual(["e-2"]);
  });

  it("S10: sort=rules поднимает письмо с большим приоритетом", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming?sort=rules", {
      token: httpToken("secretary")
    });
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.emailId)).toEqual(["e-2", "e-1"]);
  });

  it("S11: предпросмотр правила ничего не записывает и не создаёт документ", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/sorting/rules/preview", {
      token: httpToken("admin"),
      body: { name: "Приказы", matchSubject: "приказ" }
    });
    expect(res.status).toBe(200);
    const body = res.body as { matched?: number; total?: number };
    expect(body.total).toBe(2);
    expect(body.matched).toBe(1);
    expect(mockedDocflow.saveSortRule).not.toHaveBeenCalled();
    expect(mockedDocflow.deleteSortRule).not.toHaveBeenCalled();
    expect(mockedDocflow.registerDocument).not.toHaveBeenCalled();
    expect(mockedDocflow.peekNextNumber).not.toHaveBeenCalled();
  });
});

describe("этап 5 · HTTP: текст и ошибки (X1, PA5, PA6)", () => {
  it("HTML в шаблоне уведомления уходит как данные JSON, а не как разметка", async () => {
    const payload = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    mockedDocflow.getNotificationSettings.mockResolvedValue({
      enabled: true,
      dueSoonDays: 3,
      workdayDeadlines: true,
      holidays: [],
      variables: [],
      templates: [
        { key: "resolution.assigned", title: payload, body: payload, isActive: true, updatedAt: "2026-10-07T00:00:00.000Z" }
      ]
    });
    const res = await request(app.baseUrl, "GET", "/api/docflow/notifications/settings", {
      token: httpToken("admin")
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    // Ответ — JSON-объект, а не HTML-документ.
    expect(res.text.trimStart().startsWith("<")).toBe(false);
    const body = res.body as { templates?: Array<{ title?: string }> };
    expect(body.templates?.[0]?.title).toBe(payload);
  });

  it("границы полей §5 соблюдаются на пути записи: километровый матчер и приоритет вне 1..5 — 400", async () => {
    // Границы заморожены контрактом §5: матчеры ≤ 200, label ≤ 40, note ≤ 200, priority 1..5.
    // Проверяем, что отказ приходит ДО записи и что проверяет именно канонический валидатор
    // из core (вторая реализация границ — это уже расхождение с §5).
    const validate = mockedCore.validateSortRule;
    const cases: Array<Record<string, unknown>> = [
      { name: "Длинный матчер", matchSubject: "м".repeat(201) },
      { name: "Длинная метка", matchSubject: "приказ", label: "л".repeat(41) },
      { name: "Длинное примечание", matchSubject: "приказ", note: "п".repeat(201) },
      { name: "Приоритет 6", matchSubject: "приказ", priority: 6 },
      { name: "Без матчеров", matchFrom: "", matchTo: "", matchSubject: "" }
    ];
    const failures: string[] = [];
    for (const body of cases) {
      const res = await request(app.baseUrl, "POST", "/api/docflow/sorting/rules", {
        token: httpToken("admin"),
        body
      });
      if (res.status !== 400) failures.push(JSON.stringify(body).slice(0, 60) + " → " + res.status);
    }
    expect(failures).toEqual([]);
    expect(validate).toHaveBeenCalled();
  });

  it("A9: справочник типовых сроков закрыт и не падает на битой дате в праздниках", async () => {
    // Право на справочник не заморожено в §6 — проверяем только то, что не зависит от выбора:
    // аноним не получает данные, пользователь без ролей получает 403, маршрут существует.
    const anon = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=2026-10-07");
    expect(anon.status).toBe(401);

    const nobody = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=2026-10-07", {
      token: httpToken("none")
    });
    expect(nobody.status).toBe(403);

    const admin = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=2026-10-07", {
      token: httpToken("admin")
    });
    // Маршрут обязан существовать (не 404) и не падать 500 даже на мусорном from.
    expect(admin.status).not.toBe(404);
    expect(admin.status).not.toBe(500);

    const bad = await request(app.baseUrl, "GET", "/api/docflow/deadline-presets?from=не-дата", {
      token: httpToken("admin")
    });
    expect([200, 400]).toContain(bad.status);
  });

  it("PA6: отказ слоя данных на дату праздника доходит до клиента кодом 400", async () => {
    const { AppError } = jest.requireActual("@mailsense/docflow/errors") as {
      AppError: new (message: string, status: number, code: string) => Error;
    };
    mockedDocflow.saveNotificationSettings.mockRejectedValue(
      new AppError("Дата праздника должна быть в виде ГГГГ-ММ-ДД: 2026-02-30", 400, "bad_holidays")
    );
    const res = await request(app.baseUrl, "PUT", "/api/docflow/notifications/settings", {
      token: httpToken("admin"),
      body: { holidays: ["2026-02-30"] }
    });
    expect(res.status).toBe(400);
  });
});


