/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";
import {
  DeadlineTag,
  SOON_STYLE,
  dayWord,
  daysLeftText,
  overdueText
} from "../components/notifications/deadline";

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Тексты и цвета срока — stage5-ux.md §1.3, §3.1. Проверяем словами, а не «выглядит норм». */
describe("склонения срока по-русски", () => {
  it.each([
    [1, "день"],
    [2, "дня"],
    [4, "дня"],
    [5, "дней"],
    [11, "дней"],
    [21, "день"],
    [22, "дня"],
    [25, "дней"],
    [101, "день"],
    [111, "дней"]
  ])("%i → %s", (n, word) => {
    expect(dayWord(n)).toBe(word);
  });

  it("«остался 1 день», а не «осталось 1 дней»", () => {
    expect(daysLeftText(1)).toBe("остался 1 день");
    expect(daysLeftText(2)).toBe("осталось 2 дня");
    expect(daysLeftText(5)).toBe("осталось 5 дней");
  });

  it("просрочка называет число дней", () => {
    expect(overdueText(1)).toBe("просрочено на 1 день");
    expect(overdueText(2)).toBe("просрочено на 2 дня");
    expect(overdueText(5)).toBe("просрочено на 5 дней");
    expect(overdueText(-5)).toBe("просрочено на 5 дней");
  });
});

describe("плашка срока", () => {
  beforeAll(installDomEnvironment);

  it("без срока в таблице — «не указан», в карточке — «без срока»", () => {
    const table = render(<DeadlineTag deadline={null} daysLeft={null} variant="table" />);
    expect(table.getByText("не указан")).not.toBeNull();
    table.unmount();

    render(<DeadlineTag deadline={null} daysLeft={null} variant="card" />);
    expect(screen.getByText("без срока")).not.toBeNull();
  });

  it("серверный dueSoon показывает «осталось N дней»", () => {
    render(<DeadlineTag deadline="2026-10-12" daysLeft={5} dueSoon variant="table" />);
    expect(screen.getByText("осталось 5 дней")).not.toBeNull();
    expect(screen.getByText("12.10.2026")).not.toBeNull();
  });

  it("день срока — «срок сегодня»", () => {
    render(<DeadlineTag deadline="2026-10-07" daysLeft={0} dueSoon variant="card" />);
    expect(screen.getByText("07.10.2026 · срок сегодня")).not.toBeNull();
  });

  it("просрочка — дата красным и число дней", () => {
    render(<DeadlineTag deadline="2026-10-04" daysLeft={-3} overdue variant="table" />);
    expect(screen.getByText("просрочено на 3 дня")).not.toBeNull();
    expect(screen.getByText("04.10.2026")).not.toBeNull();
  });

  it("сданная в срок задача не краснеет, даже если срок уже прошёл", () => {
    render(<DeadlineTag deadline="2026-10-04" daysLeft={-3} overdue={false} variant="table" />);
    expect(screen.queryByText(/просрочено/)).toBeNull();
    expect(screen.getByText("04.10.2026")).not.toBeNull();
  });

  it("без серверного dueSoon интерфейс не гадает и показывает только дату", () => {
    render(<DeadlineTag deadline="2026-10-09" daysLeft={2} variant="table" />);
    expect(screen.getByText("09.10.2026")).not.toBeNull();
    expect(screen.queryByText(/остал/)).toBeNull();
  });

  it("дальний срок — только дата", () => {
    render(<DeadlineTag deadline="2026-11-01" daysLeft={25} dueSoon={false} variant="card" />);
    expect(screen.getByText("01.11.2026")).not.toBeNull();
  });
});

describe("цвета срока и приоритета читаются (документ §1.2)", () => {
  it("плашка «скоро» проходит AA: #ad4e00 на #fff7e6", () => {
    expect(contrast(SOON_STYLE.color, SOON_STYLE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("пресет orange (#d46b08 на #fff7e6) норму не проходит — проверка не вырождена", () => {
    expect(contrast("#d46b08", "#fff7e6")).toBeLessThan(4.5);
  });

  it("просрочка: #cf1322 на #fff1f0", () => {
    expect(contrast("#cf1322", "#fff1f0")).toBeGreaterThanOrEqual(4.5);
  });
});
