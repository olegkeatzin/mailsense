import PQueue from "p-queue";

export const analysisQueue = new PQueue({
  concurrency: Number(process.env.MAILSENSE_AI_CONCURRENCY ?? "1")
});

/** Очередь для OCR страниц вложений (параллельность 3). */
export const ocrQueue = new PQueue({
  concurrency: Number(process.env.MAILSENSE_OCR_CONCURRENCY ?? "3")
});
