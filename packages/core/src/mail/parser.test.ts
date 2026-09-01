import { classifyKind } from "./parser.js";

describe("classifyKind", () => {
  test("определяет изображения", () => {
    expect(classifyKind("image/png", "photo.png")).toBe("image");
    expect(classifyKind("image/jpeg", "photo.jpg")).toBe("image");
  });
  test("определяет PDF", () => {
    expect(classifyKind("application/pdf", "doc.pdf")).toBe("pdf");
  });
  test("определяет DOCX", () => {
    expect(
      classifyKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "contract.docx"
      )
    ).toBe("docx");
  });
  test("определяет XLSX", () => {
    expect(
      classifyKind(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "table.xlsx"
      )
    ).toBe("xlsx");
  });
  test("определяет текст и html", () => {
    expect(classifyKind("text/plain", "note.txt")).toBe("text");
    expect(classifyKind("text/html", "page.html")).toBe("html");
  });
  test("прочее — other", () => {
    expect(classifyKind("application/zip", "archive.zip")).toBe("other");
  });
});
