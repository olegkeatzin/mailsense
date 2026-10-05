/**
 * Нумерация документов и закрытие года.
 *
 * Правила заказчика:
 *  - номер — префикс плюс порядковый номер: «вх1», «исх1» (без ведущих нулей);
 *  - счётчик сбрасывается каждый год: номер уникален ВНУТРИ года, а не глобально;
 *  - новый год не открывается, пока предыдущий не выгружен в архив.
 *
 * Здесь только чистые функции — без БД и без побочных эффектов, поэтому логику
 * можно проверять отдельно от хранилища.
 */

export type NumberStream = "incoming" | "outgoing";

export interface NumberingRule {
  stream: NumberStream;
  /** Префикс номера: «вх», «исх». */
  prefix: string;
  /** Периодичность сброса счётчика. */
  reset: "year" | "never";
  /** Шаблон номера. Поддерживает {prefix}, {year}, {n}. По умолчанию «{prefix}{n}». */
  template?: string;
}

export const DEFAULT_NUMBERING_RULES: NumberingRule[] = [
  { stream: "incoming", prefix: "вх", reset: "year" },
  { stream: "outgoing", prefix: "исх", reset: "year" }
];

export function ruleForStream(rules: NumberingRule[], stream: NumberStream): NumberingRule {
  const found = rules.find((r) => r.stream === stream);
  if (!found) throw new Error("Не задано правило нумерации для потока: " + stream);
  return found;
}

/**
 * Ключ периода, к которому относится счётчик: год («2026») или «all» для
 * непрерывной нумерации.
 */
export function periodKey(date: Date, reset: NumberingRule["reset"] = "year"): string {
  return reset === "year" ? String(date.getFullYear()) : "all";
}

/** Предыдущий период для перехода «2027 → 2026». Для «all» переходов нет. */
export function previousPeriodKey(period: string): string | null {
  return /^\d{4}$/.test(period) ? String(Number(period) - 1) : null;
}

/** Собирает номер из правила: «вх» + 12 → «вх12». */
export function renderNumber(rule: NumberingRule, period: string, n: number): string {
  const template = rule.template ?? "{prefix}{n}";
  return template
    .split("{prefix}").join(rule.prefix)
    .split("{year}").join(period)
    .split("{n}").join(String(n));
}

/** Следующий номер: продолжаем прошлый или начинаем с единицы. */
export function nextNumber(lastNumber: number | null | undefined): number {
  return (lastNumber ?? 0) + 1;
}

export interface PeriodState {
  /** Год, в котором уже заведены документы (открытый период). null — журнал пуст. */
  openPeriod: string | null;
  /** Годы, выгруженные в архив. */
  archivedPeriods: string[];
}

export interface PeriodGate {
  ok: boolean;
  reason?: string;
}

/**
 * Можно ли заводить документы в этом периоде.
 *
 * Переход в следующий год разрешён только после выгрузки предыдущего в архив —
 * иначе часть документов ушедшего года осталась бы без выгрузки навсегда.
 */
export function canOpenPeriod(period: string, state: PeriodState): PeriodGate {
  if (state.openPeriod === period) return { ok: true };
  if (state.openPeriod === null) return { ok: true }; // журнал ещё пуст — открываем любой год
  if (state.archivedPeriods.includes(period)) {
    return { ok: false, reason: "Период " + period + " уже выгружен в архив и закрыт" };
  }
  const prev = previousPeriodKey(period);
  if (prev && state.openPeriod === prev) {
    return state.archivedPeriods.includes(prev)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "Год " + prev + " не выгружен в архив — новый год открыть нельзя. Сделайте экспорт журнала за " + prev + "."
        };
  }
  return {
    ok: false,
    reason: "Сначала закройте текущий период " + state.openPeriod + " выгрузкой в архив"
  };
}

/** Год считается закрытым, если по нему есть выгрузка. */
export function isPeriodClosed(period: string, archivedPeriods: string[]): boolean {
  return archivedPeriods.includes(period);
}
