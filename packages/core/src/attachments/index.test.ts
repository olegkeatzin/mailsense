import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * prepareAttachment — развилка: от неё зависит, попадёт ли содержимое вложения
 * в модель. Ошибка здесь означает молчаливую потерю документа.
 * Разбор PDF подменён (pdfjs — ESM), остальные ветки работают по-настоящему.
 */
const mockPdfToImages = jest.fn();
const mockPdfToText = jest.fn();
const mockPdfToTextResult = jest.fn();
const mockPdfPageToImage = jest.fn();

jest.mock("./pdf.js", () => ({
  __esModule: true,
  pdfToImages: (...a: unknown[]) => mockPdfToImages(...a),
  pdfToText: (...a: unknown[]) => mockPdfToText(...a),
  pdfToTextResult: (...a: unknown[]) => mockPdfToTextResult(...a),
  pdfPageToImage: (...a: unknown[]) => mockPdfPageToImage(...a)
}));

import { prepareAttachment, renderPreviewImage } from "./index.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-att-"));
  mockPdfToImages.mockReset();
  mockPdfToText.mockReset();
  mockPdfToTextResult.mockReset();
  mockPdfPageToImage.mockReset();
  mockPdfToImages.mockResolvedValue({ pages: [], totalPages: 0, truncated: false });
  mockPdfToText.mockResolvedValue("");
  mockPdfToTextResult.mockResolvedValue({ text: "", totalPages: 0, pagesRead: 0, truncated: false });
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("текстовые вложения", () => {
  test("текстовый файл читается целиком", async () => {
    const res = await prepareAttachment(dir, "e1", "note.txt", "text/plain", Buffer.from("Привет", "utf8"));
    expect(res.extractedText).toBe("Привет");
    expect(res.handled).toBe(true);
  });

  test("HTML очищается от тегов и сущностей", async () => {
    const html = "<html><style>p{color:red}</style><body><p>Счёт &amp; акт</p><script>x()</script></body></html>";
    const res = await prepareAttachment(dir, "e1", "letter.html", "text/html", Buffer.from(html, "utf8"));
    expect(res.extractedText).toBe("Счёт & акт");
  });

  test("файл вложения сохраняется на диск", async () => {
    const res = await prepareAttachment(dir, "e1", "note.txt", "text/plain", Buffer.from("данные"));
    expect(res.storagePath).toBeTruthy();
    expect(fs.readFileSync(res.storagePath!, "utf8")).toBe("данные");
  });
});

describe("изображения", () => {
  test("поддерживаемый тип превращается в data-URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await prepareAttachment(dir, "e1", "scan.png", "image/png", png);
    expect(res.images).toHaveLength(1);
    expect(res.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(res.handled).toBe(true);
  });

  test("неподдерживаемый тип помечается, а не игнорируется молча", async () => {
    const res = await prepareAttachment(dir, "e1", "scan.bmp", "image/bmp", Buffer.from("BM"));
    expect(res.handled).toBe(false);
    expect(res.note).toContain("image/bmp");
  });
});

describe("PDF", () => {
  test("страницы становятся картинками, текст извлекается отдельно", async () => {
    mockPdfToImages.mockResolvedValue({ pages: [Buffer.from([1, 2, 3])], totalPages: 1, truncated: false });
    mockPdfToTextResult.mockResolvedValue({ text: "текст документа", totalPages: 1, pagesRead: 1, truncated: false });

    const res = await prepareAttachment(dir, "e1", "акт.pdf", "application/pdf", Buffer.from("%PDF-1.4"));

    expect(res.extractedText).toBe("текст документа");
    expect(res.images).toHaveLength(1);
    expect(res.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(res.handled).toBe(true);
  });

  test("усечение по страницам попадает в примечание честным текстом", async () => {
    mockPdfToImages.mockResolvedValue({ pages: [Buffer.from([1])], totalPages: 30, truncated: true });
    const res = await prepareAttachment(dir, "e1", "том.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    expect(res.note).toContain("первые 1 страниц из 30");
  });

  test("PDF без отрендеренных страниц считается необработанным", async () => {
    mockPdfToImages.mockResolvedValue({ pages: [], totalPages: 0, truncated: false });
    const res = await prepareAttachment(dir, "e1", "пустой.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    expect(res.handled).toBe(false);
  });

  test("ошибка разбора PDF не роняет обработку письма", async () => {
    mockPdfToImages.mockRejectedValue(new Error("повреждён"));
    const res = await prepareAttachment(dir, "e1", "битый.pdf", "application/pdf", Buffer.from("%PDF"));
    expect(res.handled).toBe(false);
    expect(res.note).toContain("повреждён");
    expect(res.storagePath).toBeTruthy(); // файл всё равно сохранён
  });
});

describe("прочие типы", () => {
  test("архив помечается как неподдерживаемый", async () => {
    const res = await prepareAttachment(dir, "e1", "архив.zip", "application/zip", Buffer.from("PK"));
    expect(res.handled).toBe(false);
    expect(res.note).toBeTruthy();
  });

  test("DOCX разбирается по-настоящему", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
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
        "<w:p><w:r><w:t>Текст договора</w:t></w:r></w:p>" +
        "</w:body></w:document>"
    );
    const data = await zip.generateAsync({ type: "nodebuffer" });

    const res = await prepareAttachment(
      dir,
      "e1",
      "договор.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data
    );
    expect(res.extractedText).toContain("Текст договора");
  });
});

describe("превью вложения", () => {
  test("для PDF рендерится запрошенная страница", async () => {
    mockPdfPageToImage.mockResolvedValue(Buffer.from([0x89, 0x50]));
    const buf = await renderPreviewImage("pdf", Buffer.from("%PDF"), 3);
    expect(buf).toEqual(Buffer.from([0x89, 0x50]));
    expect(mockPdfPageToImage).toHaveBeenCalledWith(expect.anything(), 3);
  });

  test("для картинки возвращается сам файл", async () => {
    const img = Buffer.from([1, 2, 3]);
    expect(await renderPreviewImage("image", img)).toEqual(img);
  });

  test("для остальных типов превью недоступно", async () => {
    expect(await renderPreviewImage("docx", Buffer.from("x"))).toBeNull();
  });
});

describe("лимит страниц OCR", () => {
  test("по умолчанию рендерятся первые 10 страниц, обрезка — в примечании", async () => {
    mockPdfToImages.mockResolvedValue({
      pages: Array.from({ length: 10 }, (_, i) => Buffer.from([i])),
      totalPages: 12,
      truncated: true
    });
    const res = await prepareAttachment(dir, "e1", "протокол.pdf", "application/pdf", Buffer.from("%PDF-1.4"));

    expect(mockPdfToImages).toHaveBeenCalledWith(expect.anything(), 10);
    expect(res.images).toHaveLength(10);
    expect(res.note).toBe("распознаны первые 10 страниц из 12");
    expect(res.handled).toBe(true);
  });

  test("лимит можно задать явно (ai.ocrMaxPages)", async () => {
    mockPdfToImages.mockResolvedValue({
      pages: [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])],
      totalPages: 12,
      truncated: true
    });
    const res = await prepareAttachment(dir, "e1", "протокол.pdf", "application/pdf", Buffer.from("%PDF-1.4"), {
      ocrMaxPages: 3
    });

    expect(mockPdfToImages).toHaveBeenCalledWith(expect.anything(), 3);
    expect(res.note).toBe("распознаны первые 3 страниц из 12");
  });

  test("короткий PDF (≤ лимита) примечания об обрезке не получает", async () => {
    mockPdfToImages.mockResolvedValue({ pages: [Buffer.from([1]), Buffer.from([2])], totalPages: 2, truncated: false });
    const res = await prepareAttachment(dir, "e1", "короткий.pdf", "application/pdf", Buffer.from("%PDF-1.4"));

    expect(res.note).toBeUndefined();
    expect(res.images).toHaveLength(2);
    expect(res.handled).toBe(true);
  });
});

describe("текстовый слой PDF: явный лимит и режим «только текст»", () => {
  test("обрезка текстового слоя попадает в пометку вместе с обрезкой рендера", async () => {
    mockPdfToTextResult.mockResolvedValue({ text: "первые страницы", totalPages: 35, pagesRead: 20, truncated: true });
    mockPdfToImages.mockResolvedValue({ pages: [Buffer.from([1])], totalPages: 35, truncated: true });

    const res = await prepareAttachment(dir, "e1", "отчёт.pdf", "application/pdf", Buffer.from("%PDF-1.4"));

    expect(res.note).toContain("текстовый слой: прочитаны первые 20 страниц из 35");
    expect(res.note).toContain("распознаны первые 1 страниц из 35");
    expect(res.handled).toBe(true);
  });

  test("лимит текстового слоя по умолчанию 20 и настраивается", async () => {
    await prepareAttachment(dir, "e1", "а.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    expect(mockPdfToTextResult).toHaveBeenCalledWith(expect.anything(), 20);

    mockPdfToTextResult.mockClear();
    await prepareAttachment(dir, "e1", "б.pdf", "application/pdf", Buffer.from("%PDF-1.4"), { textMaxPages: 5 });
    expect(mockPdfToTextResult).toHaveBeenCalledWith(expect.anything(), 5);
  });

  test("режим «только текст» не рендерит страницы (синхронизация ящика)", async () => {
    mockPdfToTextResult.mockResolvedValue({ text: "текст слоя", totalPages: 4, pagesRead: 4, truncated: false });

    const res = await prepareAttachment(dir, "e1", "договор.pdf", "application/pdf", Buffer.from("%PDF-1.4"), {
      textOnly: true
    });

    expect(mockPdfToImages).not.toHaveBeenCalled();
    expect(res.images).toEqual([]);
    expect(res.extractedText).toBe("текст слоя");
    expect(res.handled).toBe(true);
  });

  test("скан без текстового слоя при синхронизации не помечается необработанным", async () => {
    mockPdfToTextResult.mockResolvedValue({ text: "", totalPages: 12, pagesRead: 12, truncated: false });

    const res = await prepareAttachment(dir, "e1", "скан.pdf", "application/pdf", Buffer.from("%PDF-1.4"), {
      textOnly: true
    });

    // Скан прочитает OCR на этапе анализа — «не обработано» здесь было бы ложью.
    expect(res.handled).toBe(true);
    expect(res.extractedText).toBe("");
    expect(res.images).toEqual([]);
    expect(res.note).toBeUndefined();
    expect(mockPdfToImages).not.toHaveBeenCalled();
  });

  test("при синхронизации картинка-вложение не кодируется в base64", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await prepareAttachment(dir, "e1", "фото.png", "image/png", png, { textOnly: true });

    expect(res.images).toEqual([]);
    expect(res.handled).toBe(true);
  });
});
