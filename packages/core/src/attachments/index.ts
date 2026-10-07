import type { AttachmentKind } from "../types.js";
import { DEFAULT_OCR_MAX_PAGES, DEFAULT_TEXT_MAX_PAGES } from "../config.js";
import { classifyKind } from "../mail/parser.js";
import { saveAttachmentFile } from "./store.js";
import { pdfPageToImage, pdfToImages, pdfToText, pdfToTextResult } from "./pdf.js";
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

export interface PrepareAttachmentOptions {
  /**
   * Сохранять ли файл вложения на диске.
   *
   * ⚠️ Анализу письма файл не нужен — ему нужны текст и картинки. Раньше
   * подготовка сохраняла файл ВСЕГДА, и после уникализации имён (flag "wx" +
   * суффикс «-1», «-2») каждый прогон анализа оставлял на диске копию вложения,
   * которой нет в БД: её не удаляло ни удаление письма, ни очистка вложений.
   */
  persist?: boolean;
  /**
   * Сколько страниц PDF рендерить для OCR (настройка ai.ocrMaxPages, по умолчанию 10).
   * Если страниц больше — в note уходит честная пометка «распознаны первые N страниц из M»,
   * и она попадает в промпт (см. analysisService): аппарат должен видеть, что прочитана часть.
   */
  ocrMaxPages?: number;
  /**
   * Сколько страниц PDF читать из текстового слоя (настройка ai.textMaxPages, по умолчанию 20).
   * При обрезке в note уходит честная пометка «текстовый слой: прочитаны первые N страниц из M».
   */
  textMaxPages?: number;
  /**
   * Режим синхронизации ящика: готовим ТОЛЬКО текст, без рендера и кодирования картинок.
   * mailService сохраняет из результата лишь файл, текст и признак handled — картинки при
   * скане ящика всё равно выбрасываются, а рендер PDF стоит секунды на документ.
   */
  textOnly?: boolean;
}

export async function prepareAttachment(
  dataDir: string,
  emailId: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  options: PrepareAttachmentOptions = {}
): Promise<PreparedAttachment> {
  const kind = classifyKind(mimeType, filename);
  // Путь возвращаем только когда файл действительно сохранён.
  const storagePath =
    options.persist === false ? null : saveAttachmentFile(dataDir, emailId, filename, content);
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
          // На синхронизации картинка не сохраняется в base64 — кодируем только для анализа.
          if (!options.textOnly) base.images.push(imageToDataUrl(content, mimeType));
        } else {
          base.handled = false;
          base.note = "тип изображения не поддержан моделью (" + mimeType + ")";
        }
        break;

      case "pdf": {
        const notes: string[] = [];

        const text = await pdfToTextResult(content, options.textMaxPages ?? DEFAULT_TEXT_MAX_PAGES);
        base.extractedText = text.text;
        if (text.truncated) {
          notes.push(
            "текстовый слой: прочитаны первые " + text.pagesRead + " страниц из " + text.totalPages
          );
        }

        if (options.textOnly) {
          // Сканированный PDF без текстового слоя НЕ «необработан»: его прочитает OCR на анализе.
          // Поэтому handled считаем по числу страниц, а не по наличию текста.
          base.handled = text.totalPages > 0;
        } else {
          const res = await pdfToImages(content, options.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES);
          for (const p of res.pages) base.images.push("data:image/png;base64," + p.toString("base64"));
          base.handled = res.pages.length > 0;
          // Обрезка — не «тихая потеря»: без этой пометки модель считала бы, что видела весь документ.
          if (res.truncated) {
            notes.push("распознаны первые " + res.pages.length + " страниц из " + res.totalPages);
          }
        }

        if (notes.length > 0) base.note = notes.join("; ");
        break;
      }

      case "docx": {
        const { text, images } = await docxToParts(content, { images: !options.textOnly });
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

/**
 * Рендерит превью вложения: для PDF — первую страницу в PNG, для изображения — сам файл.
 * Для остальных типов возвращает null (превью недоступно).
 */
export async function renderPreviewImage(kind: AttachmentKind, content: Buffer, page = 1): Promise<Buffer | null> {
  if (kind === "pdf") {
    return await pdfPageToImage(content, page);
  }
  if (kind === "image") {
    return content;
  }
  return null;
}

export { classifyKind, saveAttachmentFile };
export { pdfToText, pdfPageCount } from "./pdf.js";
