/**
 * pdfjs-dist — ESM-пакет (использует import.meta) и в CommonJS-режиме jest не грузится,
 * поэтому подменяем границу с библиотекой. Проверяем СВОЮ логику: нумерацию страниц,
 * лимиты, усечение, выход за диапазон и освобождение ресурсов.
 * Настоящий разбор проверен вживую: PDF письма «3175 от 31.08.2026.pdf» дал 1228 символов OCR.
 */
const mockGetDocument = jest.fn();

jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  __esModule: true,
  getDocument: (...args: unknown[]) => mockGetDocument(...args)
}));

import { pdfPageCount, pdfPageToImage, pdfToImages, pdfToText, pdfToTextResult } from "./pdf.js";

interface FakePage {
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: () => { promise: Promise<void> };
  cleanup: jest.Mock;
}

function fakeDocument(numPages: number, pageText = "Текст страницы") {
  const pages: FakePage[] = [];
  const doc = {
    numPages,
    getPage: jest.fn(async (n: number) => {
      const page: FakePage = {
        getTextContent: async () => ({ items: [{ str: pageText + " " + n }] }),
        getViewport: ({ scale }) => ({ width: 100 * scale, height: 120 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: jest.fn()
      };
      pages.push(page);
      return page;
    }),
    destroy: jest.fn(async () => undefined)
  };
  return { doc, pages };
}

function withPages(numPages: number, pageText?: string) {
  const { doc, pages } = fakeDocument(numPages, pageText);
  mockGetDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  return { doc, pages };
}

beforeEach(() => {
  mockGetDocument.mockReset();
});

describe("извлечение текста из PDF", () => {
  test("текст страницы читается с пометкой номера", async () => {
    withPages(1, "Договор поставки");
    const text = await pdfToText(Buffer.from("%PDF-1.4"));
    expect(text).toContain("Договор поставки");
    expect(text).toContain("--- стр. 1 ---");
  });

  test("страницы нумеруются по порядку", async () => {
    withPages(3, "Стр");
    const text = await pdfToText(Buffer.from("%PDF-1.4"));
    expect(text).toContain("Стр 1");
    expect(text).toContain("Стр 2");
    expect(text).toContain("Стр 3");
  });

  test("лимит страниц соблюдается", async () => {
    // Ограничение защищает от PDF на сотни страниц: OCR всего файла недопустим.
    const { doc } = withPages(5, "Стр");
    const text = await pdfToText(Buffer.from("%PDF-1.4"), 2);
    expect(text).toContain("--- стр. 2 ---");
    expect(text).not.toContain("--- стр. 3 ---");
    expect(doc.getPage).toHaveBeenCalledTimes(2);
  });

  test("документ освобождается даже при ошибке на странице", async () => {
    const { doc, pages } = fakeDocument(2);
    pages.push({
      getTextContent: async () => {
        throw new Error("страница битая");
      },
      getViewport: () => ({ width: 10, height: 10 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: jest.fn()
    } as never);
    doc.getPage = jest.fn(async () => pages[0]);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(doc) });

    await expect(pdfToText(Buffer.from("%PDF-1.4"))).rejects.toThrow("страница битая");
    // Без destroy() документ остаётся в памяти pdfjs.
    expect(doc.destroy).toHaveBeenCalled();
  });

  test("битый файл отклоняется ошибкой", async () => {
    mockGetDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF")) });
    await expect(pdfToText(Buffer.from("не pdf"))).rejects.toThrow("Invalid PDF");
  });
});

describe("число страниц", () => {
  test("читается без рендера страниц", async () => {
    // Графа «количество листов» не должна стоить рендера всего документа.
    const { doc } = withPages(7);
    expect(await pdfPageCount(Buffer.from("%PDF-1.4"))).toBe(7);
    expect(doc.getPage).not.toHaveBeenCalled();
    expect(doc.destroy).toHaveBeenCalled();
  });

  test("одностраничный документ", async () => {
    withPages(1);
    expect(await pdfPageCount(Buffer.from("%PDF-1.4"))).toBe(1);
  });

  test("битый файл отклоняется ошибкой", async () => {
    mockGetDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF")) });
    await expect(pdfPageCount(Buffer.from("не pdf"))).rejects.toThrow("Invalid PDF");
  });
});

describe("рендер страниц в картинки", () => {
  test("одна страница рендерится в PNG", async () => {
    withPages(1);
    const res = await pdfToImages(Buffer.from("%PDF-1.4"));
    expect(res.totalPages).toBe(1);
    expect(res.pages).toHaveLength(1);
    expect(res.truncated).toBe(false);
    expect(res.pages[0].subarray(0, 4).toString("hex")).toBe("89504e47"); // сигнатура PNG
  });

  test("превышение лимита помечается как усечённое", async () => {
    withPages(3);
    const res = await pdfToImages(Buffer.from("%PDF-1.4"), 2);
    expect(res.totalPages).toBe(3);
    expect(res.pages).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  test("нулевой лимит не роняет рендер", async () => {
    withPages(2);
    const res = await pdfToImages(Buffer.from("%PDF-1.4"), 0);
    expect(res.pages).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  test("страницы освобождаются после рендера", async () => {
    const { pages } = withPages(2);
    await pdfToImages(Buffer.from("%PDF-1.4"));
    expect(pages.every((p) => p.cleanup.mock.calls.length > 0)).toBe(true);
  });
});

describe("рендер одной страницы", () => {
  test("существующая страница возвращает PNG", async () => {
    withPages(2);
    const buf = await pdfPageToImage(Buffer.from("%PDF-1.4"), 2);
    expect(buf).not.toBeNull();
    expect(buf!.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  test("страница вне диапазона даёт null, а не ошибку", async () => {
    withPages(1);
    expect(await pdfPageToImage(Buffer.from("%PDF-1.4"), 2)).toBeNull();
    withPages(1);
    expect(await pdfPageToImage(Buffer.from("%PDF-1.4"), 0)).toBeNull();
  });

  test("вне диапазона документ всё равно освобождается", async () => {
    const { doc } = withPages(1);
    await pdfPageToImage(Buffer.from("%PDF-1.4"), 5);
    expect(doc.destroy).toHaveBeenCalled();
  });
});

describe("текстовый слой: явный лимит и метаданные", () => {
  test("pdfToTextResult отдаёт текст и говорит, сколько страниц прочитано", async () => {
    withPages(35, "Стр");
    const res = await pdfToTextResult(Buffer.from("%PDF-1.4"), 20);

    expect(res.totalPages).toBe(35);
    expect(res.pagesRead).toBe(20);
    expect(res.truncated).toBe(true);
    expect(res.text).toContain("--- стр. 20 ---");
    expect(res.text).not.toContain("--- стр. 21 ---");
  });

  test("короткий документ не помечается обрезанным", async () => {
    withPages(5, "Стр");
    const res = await pdfToTextResult(Buffer.from("%PDF-1.4"), 20);

    expect(res.totalPages).toBe(5);
    expect(res.pagesRead).toBe(5);
    expect(res.truncated).toBe(false);
  });

  test("pdfToText остаётся тонкой обёрткой над pdfToTextResult", async () => {
    withPages(3, "Стр");
    expect(await pdfToText(Buffer.from("%PDF-1.4"), 2)).toContain("--- стр. 2 ---");
    expect(await pdfToText(Buffer.from("%PDF-1.4"), 2)).not.toContain("--- стр. 3 ---");
  });
});

describe("«количество листов» не зависит от лимита OCR", () => {
  test("pdfPageCount считает ВСЕ страницы, даже когда рендер обрезан лимитом", async () => {
    // Обрезка OCR экономит время, но графа «Кол-во листов» в журнале обязана
    // показывать весь документ: иначе протокол с приложениями «худеет» в учёте.
    withPages(12);
    const data = Buffer.from("%PDF-1.4");
    const sheets = await pdfPageCount(data);
    const rendered = await pdfToImages(data, 10);

    expect(sheets).toBe(12);
    expect(rendered.totalPages).toBe(12);
    expect(rendered.pages).toHaveLength(10);
    expect(rendered.truncated).toBe(true);
  });
});
