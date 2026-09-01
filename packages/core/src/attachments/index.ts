import type { AttachmentKind } from "../types.js";
import { classifyKind } from "../mail/parser.js";
import { saveAttachmentFile } from "./store.js";
import { pdfToImages, pdfToText } from "./pdf.js";
import { docxToParts } from "./docx.js";
import { xlsxToText } from "./xlsx.js";
import { imageToDataUrl, SUPPORTED_IMAGE_MIME } from "./images.js";
import { logger } from "../logger.js";

export interface PreparedAttachment {
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  storagePath: string | null;
  extractedText: string | null;
  images: string[]; // data-URL (base64)
  handled: boolean;
  note?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function prepareAttachment(
  dataDir: string,
  emailId: string,
  filename: string,
  mimeType: string,
  content: Buffer
): Promise<PreparedAttachment> {
  const kind = classifyKind(mimeType, filename);
  const storagePath = saveAttachmentFile(dataDir, emailId, filename, content);
  const base: PreparedAttachment = {
    kind,
    filename,
    mimeType,
    storagePath,
    extractedText: null,
    images: [],
    handled: true
  };

  try {
    switch (kind) {
      case "image":
        if (SUPPORTED_IMAGE_MIME.test(mimeType.toLowerCase())) {
          base.images.push(imageToDataUrl(content, mimeType));
        } else {
          base.handled = false;
          base.note = "тип изображения не поддержан моделью (" + mimeType + ")";
        }
        break;

      case "pdf": {
        const res = await pdfToImages(content);
        for (const p of res.pages) base.images.push("data:image/png;base64," + p.toString("base64"));
        base.extractedText = await pdfToText(content);
        base.handled = res.pages.length > 0;
        if (res.truncated) base.note = "отображено " + res.pages.length + " из " + res.totalPages + " страниц";
        break;
      }

      case "docx": {
        const { text, images } = await docxToParts(content);
        base.extractedText = text || null;
        for (const img of images) base.images.push(imageToDataUrl(img, "image/png"));
        break;
      }

      case "xlsx":
        base.extractedText = xlsxToText(content);
        break;

      case "text":
        base.extractedText = content.toString("utf8");
        break;

      case "html":
        base.extractedText = stripHtml(content.toString("utf8"));
        break;

      default:
        base.handled = false;
        base.note = "неподдерживаемый тип вложения";
    }
  } catch (err) {
    logger.warn({ filename, err: (err as Error).message }, "Ошибка обработки вложения");
    base.handled = false;
    base.note = "ошибка обработки: " + (err as Error).message;
  }
  return base;
}

export { classifyKind, saveAttachmentFile };
export { pdfToText } from "./pdf.js";
