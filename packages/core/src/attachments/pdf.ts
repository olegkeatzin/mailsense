import { createCanvas, Path2D as NapiPath2D, DOMMatrix as NapiDOMMatrix } from "@napi-rs/canvas";
import { DEFAULT_TEXT_MAX_PAGES } from "../config.js";

(globalThis as Record<string, unknown>).Path2D ??= NapiPath2D;
(globalThis as Record<string, unknown>).DOMMatrix ??= NapiDOMMatrix;

export interface PdfRenderResult {
  pages: Buffer[];
  totalPages: number;
  truncated: boolean;
}

export interface PdfTextResult {
  /** Склеенный текст прочитанных страниц (с маркерами «--- стр. N ---»). */
  text: string;
  /** Всего страниц в документе. */
  totalPages: number;
  /** Сколько страниц реально прочитано (ограничено лимитом). */
  pagesRead: number;
  /** Документ длиннее лимита — часть текста НЕ прочитана. */
  truncated: boolean;
}

/**
 * Текст вложенного слоя PDF с явным лимитом страниц.
 *
 * Лимит здесь не про экономию времени (чтение слоя почти бесплатно — миллисекунды на страницу),
 * а про честность: раньше предел 20 страниц был зашит в значение по умолчанию и о нём никто
 * не знал — длинный документ молча отдавал в промпт только начало. Теперь вызывающий код
 * знает totalPages/pagesRead и обязан сказать об обрезке.
 */
export async function pdfToTextResult(data: Buffer, maxPages = DEFAULT_TEXT_MAX_PAGES): Promise<PdfTextResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const parts: string[] = [];
  const totalPages = doc.numPages;
  const limit = Math.min(totalPages, maxPages);
  try {
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ((it as { str?: string }).str ?? ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) parts.push("--- стр. " + i + " ---\n" + text);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return { text: parts.join("\n\n"), totalPages, pagesRead: limit, truncated: totalPages > limit };
}

/** Только текст. Обёртка над pdfToTextResult — для вызовов, которым метаданные не нужны. */
export async function pdfToText(data: Buffer, maxPages = DEFAULT_TEXT_MAX_PAGES): Promise<string> {
  return (await pdfToTextResult(data, maxPages)).text;
}

/**
 * Число страниц в PDF. Нужно для графы «количество листов» в журнале:
 * рендерить страницы ради этого не требуется, достаточно открыть документ.
 */
export async function pdfPageCount(data: Buffer): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

export async function pdfToImages(data: Buffer, maxPages = 6, scale = 1.5): Promise<PdfRenderResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const totalPages = doc.numPages;
  const pages: Buffer[] = [];
  const limit = Math.min(totalPages, maxPages);
  try {
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx as any, viewport }).promise;
      pages.push(canvas.toBuffer("image/png"));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return { pages, totalPages, truncated: totalPages > limit };
}

/** Рендерит ОДНУ конкретную страницу PDF в PNG (1-based). */
export async function pdfPageToImage(data: Buffer, pageNumber: number, scale = 1.5): Promise<Buffer | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) return null;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx as any, viewport }).promise;
    const buf = canvas.toBuffer("image/png");
    page.cleanup();
    return buf;
  } finally {
    await doc.destroy();
  }
}
