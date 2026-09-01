import { createCanvas, Path2D as NapiPath2D, DOMMatrix as NapiDOMMatrix } from "@napi-rs/canvas";

(globalThis as Record<string, unknown>).Path2D ??= NapiPath2D;
(globalThis as Record<string, unknown>).DOMMatrix ??= NapiDOMMatrix;

export interface PdfRenderResult {
  pages: Buffer[];
  totalPages: number;
  truncated: boolean;
}

export async function pdfToText(data: Buffer, maxPages = 20): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const parts: string[] = [];
  const limit = Math.min(doc.numPages, maxPages);
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
  return parts.join("\n\n");
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
