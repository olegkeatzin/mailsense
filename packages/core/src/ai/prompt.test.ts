import { buildPrompt, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE, type PromptInput } from "./prompt.js";

/**
 * Промпт — единственный канал, через который письмо и вложения попадают в модель.
 * Потеря вложения или подстановка «undefined» тихо ухудшают выжимку, поэтому
 * проверяем сборку по частям.
 */
function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    subject: "Письмо",
    from: "sender@test.local",
    date: "2026-01-15T10:00:00.000Z",
    bodyText: "Текст письма",
    attachmentTexts: [],
    attachmentNotes: [],
    imageCount: 0,
    attachmentNames: [],
    ...over
  };
}

describe("сборка промпта", () => {
  test("содержит системную инструкцию и текст письма", () => {
    const p = buildPrompt(input());
    expect(p).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(p).toContain("Текст письма");
    expect(p).toContain("sender@test.local");
    expect(p).toContain("Письмо");
  });

  test("подставляет отправителя, дату и тело в шаблон", () => {
    const p = buildPrompt(
      input({ from: "a@b.c", date: "2026-02-02", bodyText: "тело" }),
      { userTemplate: "От: {{from}} | Дата: {{date}} | {{body}}" }
    );
    expect(p).toContain("От: a@b.c");
    expect(p).toContain("Дата: 2026-02-02");
    expect(p.endsWith("тело")).toBe(true);
  });

  test("пустые поля заменяются понятными заглушками, а не «undefined»", () => {
    const p = buildPrompt(input({ from: "", date: null, bodyText: "" }));
    expect(p).toContain("(неизвестен)");
    expect(p).toContain("(неизвестна)");
    expect(p).toContain("(пусто)");
    expect(p).not.toContain("undefined");
  });

  test("неизвестная переменная шаблона не остаётся как {{...}}", () => {
    const p = buildPrompt(input(), { userTemplate: "Значение: {{нет_такой}}" });
    expect(p).not.toContain("{{");
    expect(p).toContain("Значение: ");
  });

  test("свой системный промпт заменяет встроенный", () => {
    const p = buildPrompt(input(), { system: "МОЯ ИНСТРУКЦИЯ" });
    expect(p.startsWith("МОЯ ИНСТРУКЦИЯ")).toBe(true);
    expect(p).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("вложения", () => {
  test("тексты вложений попадают с именами файлов", () => {
    const p = buildPrompt(
      input({
        attachmentTexts: ["содержимое PDF"],
        attachmentNames: ["3175 от 31.08.2026.pdf"]
      })
    );
    expect(p).toContain("=== 3175 от 31.08.2026.pdf ===");
    expect(p).toContain("содержимое PDF");
  });

  test("пустые тексты вложений не создают пустых блоков", () => {
    const p = buildPrompt(
      input({ attachmentTexts: ["", "   ", "реальный текст"], attachmentNames: ["a.pdf", "b.pdf", "c.pdf"] })
    );
    expect(p).toContain("=== c.pdf ===");
    expect(p).not.toContain("=== a.pdf ===");
    expect(p).not.toContain("=== b.pdf ===");
  });

  test("без имени файла подставляется порядковый номер", () => {
    const p = buildPrompt(input({ attachmentTexts: ["текст"], attachmentNames: [] }));
    expect(p).toContain("=== вложение #1 ===");
  });

  test("список вложений перечисляет все файлы, включая нечитаемые", () => {
    const p = buildPrompt(
      input({ attachmentNames: ["scan.pdf", "photo.jpg"], attachmentTexts: ["текст"] })
    );
    expect(p).toContain("Вложения:");
    expect(p).toContain("- scan.pdf");
    expect(p).toContain("- photo.jpg");
  });

  test("без вложений блок списка не рисуется", () => {
    const p = buildPrompt(input());
    expect(p).not.toContain("Вложения:");
  });

  test("изображения упоминаются отдельной строкой", () => {
    const p = buildPrompt(input({ imageCount: 3 }));
    expect(p).toContain("изображения/страницы документов (3 шт.)");
  });

  test("без изображений упоминания нет", () => {
    expect(buildPrompt(input())).not.toContain("переданы отдельно");
  });

  test("примечания по вложениям идут списком", () => {
    const p = buildPrompt(input({ attachmentNotes: ["первое", "второе"] }));
    expect(p).toContain("Примечания по вложениям:");
    expect(p).toContain("- первое");
    expect(p).toContain("- второе");
  });
});

describe("шаблон по умолчанию", () => {
  test("используется, когда свой не задан", () => {
    const p = buildPrompt(input());
    expect(p).toContain(DEFAULT_USER_TEMPLATE.slice(0, 20));
  });
});
