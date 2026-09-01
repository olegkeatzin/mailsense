import PQueue from "p-queue";

export const analysisQueue = new PQueue({
  concurrency: Number(process.env.MAILSENSE_AI_CONCURRENCY ?? "1")
});
