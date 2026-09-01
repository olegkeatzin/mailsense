import { extractJson, parseAnalysis } from "./parse.js";

describe("extractJson", () => {
  test("возвращает plain JSON как есть", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  test("вытаскивает JSON из markdown-кода", () => {
    const raw = "```json\n{\"summary\":\"x\"}\n```";
    expect(extractJson(raw)).toBe('{"summary":"x"}');
  });

  test("находит JSON внутри текста", () => {
    expect(extractJson('Пояснение {"tags":["a"]} конец')).toBe('{"tags":["a"]}');
  });
});

describe("parseAnalysis", () => {
  test("разбирает полный ответ", () => {
    const r = parseAnalysis(
      '{"summary":"Тест","tags":["счёт","срочно"],"priority":5,"urgent":true,"event_date":"2026-01-15","category":"work"}'
    );
    expect(r.summary).toBe("Тест");
    expect(r.tags).toEqual(["счёт", "срочно"]);
    expect(r.priority).toBe(5);
    expect(r.urgent).toBe(true);
    expect(r.event_date).toBe("2026-01-15");
    expect(r.category).toBe("work");
  });

  test("заполняет значения по умолчанию", () => {
    const r = parseAnalysis('{"summary":"x"}');
    expect(r.tags).toEqual([]);
    expect(r.priority).toBe(3);
    expect(r.urgent).toBe(false);
    expect(r.event_date).toBeNull();
    expect(r.category).toBe("personal");
  });

  test("отклоняет неверную категорию", () => {
    expect(() => parseAnalysis('{"category":"unknown"}')).toThrow();
  });
});
