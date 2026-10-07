import JSZip from "jszip";
import { docxToParts } from "./docx.js";

/**
 * DOCX — это zip. Текст берём через mammoth, картинки — прямо из архива.
 * Собираем документ прямо в тесте: внешний файл-образец здесь не нужен.
 */
async function buildDocx(text: string, withImage = true): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>"
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>"
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      "<w:p><w:r><w:t>" + text + "</w:t></w:r></w:p>" +
      "</w:body></w:document>"
  );
  if (withImage) {
    zip.file("word/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("разбор DOCX", () => {
  test("текст документа извлекается", async () => {
    const data = await buildDocx("Текст договора");
    const parts = await docxToParts(data);
    expect(parts.text).toContain("Текст договора");
  });

  test("картинки достаются из архива", async () => {
    const data = await buildDocx("С картинкой", true);
    const parts = await docxToParts(data);
    expect(parts.images).toHaveLength(1);
    expect(parts.images[0][0]).toBe(0x89); // PNG-сигнатура
  });

  test("документ без картинок даёт пустой список", async () => {
    const data = await buildDocx("Без картинок", false);
    const parts = await docxToParts(data);
    expect(parts.images).toEqual([]);
  });

  test("в режиме «только текст» картинки не читаются", async () => {
    const data = await buildDocx("Только текст", true);
    const parts = await docxToParts(data, { images: false });
    expect(parts.text).toContain("Только текст");
    expect(parts.images).toEqual([]);
  });

  test("битый файл не роняет разбор — возвращаются пустые части", async () => {
    const parts = await docxToParts(Buffer.from("это не docx"));
    expect(parts.text).toBe("");
    expect(parts.images).toEqual([]);
  });

  test("настоящий DOCX больше не считается битым", async () => {
    const data = await buildDocx("Проверка целостности");
    expect(data.length).toBeGreaterThan(100);
    expect((await docxToParts(data)).text).toContain("Проверка целостности");
  });
});
