import PQueue from "p-queue";

// Ставим тип явно: без аннотации выведенный тип ссылается на внутренний путь p-queue
// (`p-queue/dist/priority-queue`), и TS2742 делает объявление непереносимым для потребителей
// пакета — server и electron теряли тип этой очереди.
export const analysisQueue: PQueue = new PQueue({
  concurrency: Number(process.env.MAILSENSE_AI_CONCURRENCY ?? "1")
});

/** Очередь для OCR страниц вложений (параллельность 3). */
export const ocrQueue: PQueue = new PQueue({
  concurrency: Number(process.env.MAILSENSE_OCR_CONCURRENCY ?? "3")
});
