import { priorityColor, statusColor } from "../utils";
import type { AnalysisStatus } from "../types";
import {
  BADGE_STYLE,
  DANGER_BG,
  DANGER_COLOR,
  GOLD_STYLE,
  READY_STYLE,
  RULE_TAG_STYLE,
  SOON_STYLE
} from "../components/notifications/colors";

/** Относительная яркость по WCAG 2.x. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст двух цветов (порядок не важен). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/**
 * Читаемость цветов интерфейса.
 *
 * Тест проверяет РЕАЛЬНЫЕ токены (импорт из colors.ts/utils.ts), а не их копию:
 * копия пережила бы смену цвета и создавала бы ложную уверенность (rules §2.3).
 */
describe("читаемость цветов интерфейса", () => {
  const statuses: AnalysisStatus[] = ["pending", "queued", "processing", "ready", "error"];

  it.each(statuses)("цвет статуса «%s» читается на белом (не ниже 4.5:1)", (status) => {
    const ratio = contrastWithWhite(statusColor(status));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("прежний светло-зелёный норму не проходил — проверка не вырождена", () => {
    expect(contrastWithWhite("#52c41a")).toBeLessThan(4.5);
  });
});

/** Нарушения, найденные ux-designer (stage5-ux.md §11) и починенные в этапе 5. */
describe("срок, счётчик и метки правил", () => {
  it("плашка срока «скоро»: #ad4e00 на #fff7e6", () => {
    expect(contrast(SOON_STYLE.color, SOON_STYLE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("просрочка: #cf1322 на белом и на red-1", () => {
    expect(contrastWithWhite(DANGER_COLOR)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(DANGER_COLOR, DANGER_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it("счётчик непрочитанных: белый на #cf1322", () => {
    expect(contrast("#ffffff", BADGE_STYLE.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  it("«сдано»/«готово»: #237804 на #f6ffed", () => {
    expect(contrast(READY_STYLE.color, READY_STYLE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("метка правила: #0958d9 на #e6f4ff", () => {
    expect(contrast(RULE_TAG_STYLE.color, RULE_TAG_STYLE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("пресеты Ant, которые мы не используем, норму не проходят — проверка не вырождена", () => {
    expect(contrast("#d46b08", "#fff7e6")).toBeLessThan(4.5); // Tag color="orange"
    expect(contrast("#389e0d", "#f6ffed")).toBeLessThan(4.5); // Tag color="green"
    expect(contrast("#ffffff", "#ff4d4f")).toBeLessThan(4.5); // Badge по умолчанию
    expect(contrast("#d48806", "#fffbe6")).toBeLessThan(4.5); // Tag color="gold"
  });

  it("«ждёт подтверждения»: #874d00 на #fffbe6", () => {
    expect(contrast(GOLD_STYLE.color, GOLD_STYLE.background)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Точка приоритета в списке писем: #fadb14 давал 1.38:1 — практически невидимо,
 * а #52c41a/#fa8c16/#1890ff — 2.3/2.4/3.2:1. Требование А7: только палитра Ant и AA.
 */
describe("цвет приоритета письма", () => {
  it.each([1, 2, 3, 4, 5])("приоритет %i читается на белом (не ниже 4.5:1)", (p) => {
    expect(contrastWithWhite(priorityColor(p))).toBeGreaterThanOrEqual(4.5);
  });

  it("прежний жёлтый #fadb14 норму не проходил — проверка не вырождена", () => {
    expect(contrastWithWhite("#fadb14")).toBeLessThan(4.5);
  });
});
