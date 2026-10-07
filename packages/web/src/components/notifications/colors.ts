/**
 * Цветовые токены этапа 5 — одним местом.
 *
 * Вынесены из компонентов, чтобы contrast.test.ts проверял РЕАЛЬНЫЕ значения, а не их
 * копию в тесте: иначе тест переживёт смену цвета и будет создавать ложную уверенность.
 * Значения — только из палитры Ant Design, все пары проходят WCAG AA (stage5-ux.md §1.2).
 */

/** Плашка срока «скоро» и «сегодня». Пресет color="orange" даёт 3.34:1 — не проходит. */
export const SOON_STYLE = { color: "#ad4e00", background: "#fff7e6", borderColor: "#ffd591" } as const;

/** Просрочка: текст на белом (5.57:1) и на red-1 (5.07:1). */
export const DANGER_COLOR = "#cf1322";
export const DANGER_BG = "#fff1f0";

/** «Сдано»/«готово»: пресет color="green" даёт 3.37:1 — не проходит. */
export const READY_STYLE = { color: "#237804", background: "#f6ffed", borderColor: "#b7eb8f" } as const;

/** Счётчик непрочитанных: Ant по умолчанию (#ff4d4f) даёт 3.27:1. */
export const BADGE_STYLE = { backgroundColor: "#cf1322" } as const;

/** Метка правила сортировки: #0958d9 на blue-1 (5.50:1). */
export const RULE_TAG_STYLE = { color: "#0958d9", background: "#e6f4ff" } as const;

/** «Ждёт подтверждения»: пресет color="gold" даёт 2.76:1 — не проходит. */
export const GOLD_STYLE = { color: "#874d00", background: "#fffbe6", borderColor: "#ffe58f" } as const;
