import { concurrencyFromEnv } from "./concurrency.js";

/**
 * Живой сбой контейнера: `MAILSENSE_AI_CONCURRENCY=` (пусто) → Number("") = 0 → p-queue
 * бросает исключение при импорте, сервер не стартует вовсе. Проверяем, что пустое,
 * нулевое, отрицательное и мусорное значение даёт запасное, а нормальное — своё.
 */
describe("параллельность очередей ИИ", () => {
  it("пустая переменная даёт запасное значение, а не 0", () => {
    expect(concurrencyFromEnv("", 1)).toBe(1);
    expect(concurrencyFromEnv(undefined, 3)).toBe(3);
    expect(concurrencyFromEnv("   ", 2)).toBe(2);
  });

  it("ноль и отрицательные значения не проходят", () => {
    expect(concurrencyFromEnv("0", 1)).toBe(1);
    expect(concurrencyFromEnv("-4", 3)).toBe(3);
  });

  it("мусор не ломает очередь", () => {
    expect(concurrencyFromEnv("abc", 1)).toBe(1);
    expect(concurrencyFromEnv("2x", 3)).toBe(3);
  });

  it("нормальное число применяется, дробное округляется вниз", () => {
    expect(concurrencyFromEnv("5", 1)).toBe(5);
    expect(concurrencyFromEnv("2.9", 1)).toBe(2);
  });

  it("испорченное запасное значение не роняет очередь", () => {
    expect(concurrencyFromEnv("", 0)).toBe(1);
    expect(concurrencyFromEnv("", Number.NaN)).toBe(1);
  });
});
