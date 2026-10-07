import { notificationTime } from "../components/notifications/texts";

/**
 * Относительное время в списке уведомлений (stage5-ux.md §1.4).
 * Границы проверяем явно: «59 минут» не должно превращаться в «1 час назад» раньше времени.
 */
describe("время уведомления", () => {
  const now = new Date(2026, 9, 7, 23, 0, 0);

  const at = (msAgo: number, n: Date = now) => new Date(n.getTime() - msAgo).toISOString();

  it("моложе минуты — «только что»", () => {
    expect(notificationTime(at(30_000), now).label).toBe("только что");
  });

  it("одна минута — «1 минуту назад»", () => {
    expect(notificationTime(at(60_000), now).label).toBe("1 минуту назад");
  });

  it("пять минут — «5 минут назад»", () => {
    expect(notificationTime(at(5 * 60_000), now).label).toBe("5 минут назад");
  });

  it("59 минут ещё минуты, а не часы", () => {
    expect(notificationTime(at(59 * 60_000), now).label).toBe("59 минут назад");
  });

  it("час — «1 час назад», пять — «5 часов назад»", () => {
    expect(notificationTime(at(60 * 60_000), now).label).toBe("1 час назад");
    expect(notificationTime(at(3 * 60 * 60_000), now).label).toBe("3 часа назад");
    expect(notificationTime(at(5 * 60 * 60_000), now).label).toBe("5 часов назад");
  });

  it("23 часа — ещё «часов назад»", () => {
    expect(notificationTime(at(23 * 60 * 60_000), now).label).toBe("23 часа назад");
  });

  it("вчера — «вчера, HH:mm»", () => {
    const yesterday = new Date(2026, 9, 6, 14, 5, 0);
    expect(notificationTime(yesterday.toISOString(), now).label).toBe("вчера, 14:05");
  });

  it("позавчера — уже абсолютная дата, и она же в exact", () => {
    const twoDays = new Date(2026, 9, 5, 10, 0, 0);
    const r = notificationTime(twoDays.toISOString(), now);
    expect(r.label).toBe(r.exact);
    expect(r.label).toContain("2026");
  });

  it("кривая дата — пустые строки, а не «Invalid Date»", () => {
    expect(notificationTime("не дата", now)).toEqual({ label: "", exact: "" });
  });
});
