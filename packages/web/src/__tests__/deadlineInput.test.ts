import { parseTypedDate } from "../utils/deadlineInput";

/** Ввод срока: разбираем оба привычных формата и не пропускаем несуществующие даты. */
describe("разбор набранной даты срока", () => {
  it("русский формат «12.10.2026»", () => {
    expect(parseTypedDate("12.10.2026")).toBe("2026-10-12");
    expect(parseTypedDate("1.2.2026")).toBe("2026-02-01");
    expect(parseTypedDate("12/10/2026")).toBe("2026-10-12");
  });

  it("ISO-формат «2026-10-12»", () => {
    expect(parseTypedDate("2026-10-12")).toBe("2026-10-12");
    expect(parseTypedDate("2026-1-2")).toBe("2026-01-02");
  });

  it("пустое и мусор — null, а не выдуманная дата", () => {
    expect(parseTypedDate("")).toBeNull();
    expect(parseTypedDate("   ")).toBeNull();
    expect(parseTypedDate(null)).toBeNull();
    expect(parseTypedDate("завтра")).toBeNull();
    expect(parseTypedDate("12.10")).toBeNull();
  });

  it("несуществующая дата не проходит", () => {
    expect(parseTypedDate("31.02.2026")).toBeNull();
    expect(parseTypedDate("32.01.2026")).toBeNull();
    expect(parseTypedDate("01.13.2026")).toBeNull();
  });
});
