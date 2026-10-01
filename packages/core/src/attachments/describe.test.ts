import { matchAttachmentDescriptions } from "./describe.js";

describe("matchAttachmentDescriptions", () => {
  test("точное совпадение имени", () => {
    const map = matchAttachmentDescriptions(
      [{ id: "a1", filename: "act.pdf" }],
      [{ name: "act.pdf", description: "акт" }]
    );
    expect(map.get("a1")).toBe("акт");
  });

  test("регистр, пробелы и путь в имени не мешают", () => {
    const map = matchAttachmentDescriptions(
      [{ id: "a1", filename: "image001.png" }],
      [{ name: "  IMAGE001.PNG ", description: "картинка" }]
    );
    expect(map.get("a1")).toBe("картинка");
  });

  test("вхождение имени (модель усекла/добавила текст)", () => {
    const map = matchAttachmentDescriptions(
      [{ id: "a1", filename: "Вх. №1575 от 24.07.2026.pdf" }],
      [{ name: "1575.pdf", description: "входящее" }]
    );
    expect(map.get("a1")).toBe("входящее");
  });

  test("пустое описание игнорируется, чужой файл не привязывается", () => {
    const map = matchAttachmentDescriptions(
      [{ id: "a1", filename: "act.pdf" }],
      [
        { name: "act.pdf", description: "   " },
        { name: "other.pdf", description: "чужое" }
      ]
    );
    expect(map.size).toBe(0);
  });

  test("не перезаписывает описание одного вложения дважды", () => {
    const map = matchAttachmentDescriptions(
      [{ id: "a1", filename: "act.pdf" }],
      [
        { name: "act.pdf", description: "первое" },
        { name: "act.pdf", description: "второе" }
      ]
    );
    expect(map.get("a1")).toBe("первое");
  });
});
