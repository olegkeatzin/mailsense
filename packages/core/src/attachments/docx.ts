import mammoth from "mammoth";
import JSZip from "jszip";

export interface DocxParts {
  text: string;
  images: Buffer[];
}

export async function docxToParts(data: Buffer): Promise<DocxParts> {
  let text = "";
  try {
    const res = await mammoth.extractRawText({ buffer: data as Buffer });
    text = res.value;
  } catch {
    text = "";
  }

  const images: Buffer[] = [];
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
  return { text, images };
}
