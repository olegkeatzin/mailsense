/**
 * Автосортировка писем: маршрутизация и подсветка, а НЕ авторегистрация.
 *
 * Правило помечает письмо меткой, приоритетом и подсказкой аппарату и поднимает его в очереди;
 * документ по-прежнему создаёт человек (rules.md §6.1, контракт этапа 5 §0).
 *
 * Чистая логика: ни БД, ни сети, ни времени — функцию можно звать на каждом чтении списка.
 *
 * ⚠️ Сравнение — только в JS (`toLowerCase()` + `includes`):
 *   в SQL `lower()` по кириллице не работает (rules.md §5.6 — это уже стоило бага),
 *   поэтому вторая реализация матчинга в SQL запрещена контрактом (§6).
 *   Регулярные выражения не используем вовсе: матчеры вводит человек, ReDoS нам не нужен.
 */

export interface MailSortRule {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  matchFrom: string;
  matchTo: string;
  matchSubject: string;
  label: string;
  priority: number | null;
  note: string;
}

export interface MailSortInput {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
}

export interface MailSortMatch {
  /** Сработало хотя бы одно правило. */
  matched: boolean;
  /** Метки сработавших правил: порядок применения, без дублей и пустых. */
  labels: string[];
  /** Подсказки аппарату: порядок применения, без пустых. */
  notes: string[];
  /** Максимум среди сработавших правил (5 — важнее всего) или null, если никто не задал. */
  priority: number | null;
  /** id сработавших правил в порядке применения. */
  ruleIds: string[];
}

/** Границы из контракта этапа 5 (§5). */
const LIMITS = {
  name: 120,
  matcher: 200,
  label: 40,
  note: 200,
  priorityMin: 1,
  priorityMax: 5,
} as const;

type TextFieldKey = "name" | "matchFrom" | "matchTo" | "matchSubject" | "label" | "note";

const TEXT_FIELDS: ReadonlyArray<{ key: TextFieldKey; title: string; max: number }> = [
  { key: "name", title: "Название правила", max: LIMITS.name },
  { key: "matchFrom", title: "Матчер «Отправитель»", max: LIMITS.matcher },
  { key: "matchTo", title: "Матчер «Получатель»", max: LIMITS.matcher },
  { key: "matchSubject", title: "Матчер «Тема»", max: LIMITS.matcher },
  { key: "label", title: "Метка", max: LIMITS.label },
  { key: "note", title: "Примечание", max: LIMITS.note },
];

/** Строка как есть; null/undefined — пусто; не текст возвращаем как null (для ошибки типа). */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : null;
}

/** Пустой матчер — «любой»; матчер из одних пробелов тоже пустой. */
function isBlankMatcher(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/** Нормализация матчера: обрезка краёв и нижний регистр (для includes). */
function normalizeMatcher(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Нормализация текста письма: только нижний регистр, содержимое не трогаем. */
function normalizeHaystack(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Порядок применения: `sortOrder` ASC, затем `id`.
 * Без `localeCompare`: он зависит от локали процесса и менял бы порядок меток на разных машинах.
 */
function compareRules(a: MailSortRule, b: MailSortRule): number {
  const sa = Number.isFinite(a.sortOrder) ? a.sortOrder : 0;
  const sb = Number.isFinite(b.sortOrder) ? b.sortOrder : 0;
  if (sa !== sb) return sa - sb;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Проверяет правило перед сохранением. Возвращает понятные русские тексты ошибок.
 * Пустое имя правилом не запрещено (контракт §5 такого требования не содержит).
 */
export function validateSortRule(rule: Partial<MailSortRule>): { ok: boolean; errors: string[] } {
  const input: unknown = rule;
  if (input === null || input === undefined || typeof input !== "object") {
    return { ok: false, errors: ["Правило не задано"] };
  }
  const candidate = input as Record<string, unknown>;
  const errors: string[] = [];
  const values: Record<string, string> = {};

  for (const field of TEXT_FIELDS) {
    const raw = asText(candidate[field.key]);
    if (raw === null) {
      errors.push(`${field.title}: ожидается текст`);
      values[field.key] = "";
      continue;
    }
    values[field.key] = raw;
    if (raw.length > field.max) {
      errors.push(`${field.title} длиннее ${field.max} символов (сейчас ${raw.length})`);
    }
  }

  // Правило без единого матчера ловит ВСЮ почту — это ошибка настройки, а не «правило по умолчанию».
  if (
    isBlankMatcher(values.matchFrom) &&
    isBlankMatcher(values.matchTo) &&
    isBlankMatcher(values.matchSubject)
  ) {
    errors.push(
      "Укажите хотя бы один матчер — отправителя, получателя или тему: правило без матчеров ловит всю почту"
    );
  }

  const priority = candidate.priority;
  if (priority !== null && priority !== undefined) {
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < LIMITS.priorityMin ||
      priority > LIMITS.priorityMax
    ) {
      errors.push(
        `Приоритет должен быть целым числом от ${LIMITS.priorityMin} до ${LIMITS.priorityMax} или пустым`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Применяет правила к письму. Неактивные и «пустые» правила (все три матчера без текста)
 * не участвуют; порядок применения — `sortOrder` ASC, затем `id`.
 */
export function matchSortRules(rules: MailSortRule[], mail: MailSortInput): MailSortMatch {
  const empty: MailSortMatch = { matched: false, labels: [], notes: [], priority: null, ruleIds: [] };
  const listInput: unknown = rules;
  if (!Array.isArray(listInput)) return empty;

  const haystack = {
    from: normalizeHaystack((mail as MailSortInput | undefined)?.from),
    to: normalizeHaystack((mail as MailSortInput | undefined)?.to),
    subject: normalizeHaystack((mail as MailSortInput | undefined)?.subject),
  };

  const applicable = (listInput as MailSortRule[])
    .filter((rule) => rule !== null && typeof rule === "object" && rule.isActive === true)
    .filter(
      (rule) => !isBlankMatcher(rule.matchFrom) || !isBlankMatcher(rule.matchTo) || !isBlankMatcher(rule.matchSubject)
    )
    .slice()
    .sort(compareRules);

  const labels: string[] = [];
  const notes: string[] = [];
  const ruleIds: string[] = [];
  let priority: number | null = null;

  for (const rule of applicable) {
    if (!haystack.from.includes(normalizeMatcher(rule.matchFrom))) continue;
    if (!haystack.to.includes(normalizeMatcher(rule.matchTo))) continue;
    if (!haystack.subject.includes(normalizeMatcher(rule.matchSubject))) continue;

    ruleIds.push(rule.id);

    const label = typeof rule.label === "string" ? rule.label.trim() : "";
    if (label !== "" && !labels.includes(label)) labels.push(label);

    const note = typeof rule.note === "string" ? rule.note.trim() : "";
    if (note !== "") notes.push(note);

    // Приоритет вне 1..5 — след испорченной базы, в результат его не тащим.
    const rulePriority = rule.priority;
    if (
      typeof rulePriority === "number" &&
      Number.isInteger(rulePriority) &&
      rulePriority >= LIMITS.priorityMin &&
      rulePriority <= LIMITS.priorityMax
    ) {
      if (priority === null || rulePriority > priority) priority = rulePriority;
    }
  }

  return { matched: ruleIds.length > 0, labels, notes, priority, ruleIds };
}
