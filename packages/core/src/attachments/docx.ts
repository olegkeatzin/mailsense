import mammoth from "mammoth";
import JSZip from "jszip";

export interface DocxParts {
  text: string;
  images: Buffer[];
}

export interface DocxPartsOptions {
  /**
   * Читать картинки из архива. На синхронизации ящика они не нужны: mailService
   * сохраняет файл и текст, а base64-картинки выбрасывает — это зряшная работа.
   */
  images?: boolean;
}

export async function docxToParts(data: Buffer, options: DocxPartsOptions = {}): Promise<DocxParts> {
  let text = "";
  try {
    const res = await mammoth.extractRawText({ buffer: data as Buffer });
    text = res.value;
  } catch {
    text = "";
  }

  const images: Buffer[] = [];
  if (options.images !== false) {
    try {
      const zip = await JSZip.loadAsync(data);
      for (const [name, file] of Object.entries(zip.files)) {
        if (name.startsWith("word/media/") && !file.dir) {
          images.push(await file.async("nodebuffer"));
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { text, images };
}
