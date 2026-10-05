import { statusColor } from "../utils";
import type { AnalysisStatus } from "../types";

/** Относительная яркость по WCAG 2.x. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

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
