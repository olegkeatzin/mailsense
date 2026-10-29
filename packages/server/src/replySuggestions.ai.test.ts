jest.mock("@mailsense/core", () => ({
  getEmailView: jest.fn(() => ({
    id: "e-1",
    accountId: "acc-1",
    from: { address: "executor@stand.test" },
    to: [],
    cc: [],
    bodyText: "Ответ подготовлен и отправлен",
    headers: null
  })),
  getAiConfig: jest.fn(() => ({})),
  analyzeReportReply: jest.fn(),
  extractApprovalInstruction: jest.fn(),
  getAccountById: jest.fn(() => null),
  logger: { warn: jest.fn() }
}));

jest.mock("@mailsense/docflow", () => ({
  listReplyCandidates: jest.fn(async () => []),
  matchReplies: jest.fn(() => [])
}));

import { analyzeReportReply } from "@mailsense/core";
import { suggestFields } from "./replySuggestions.js";

describe("черновик полей по письму", () => {
  it("для отчёта возвращает ответ модели", async () => {
    (analyzeReportReply as jest.Mock).mockResolvedValueOnce({ isReport: true, summary: "Ответ направлен" });

    await expect(suggestFields("e-1", "report")).resolves.toEqual({
      text: "Ответ направлен",
      source: "ai"
    });
  });

  it("если модель не увидела отчёт, оставляет текст письма для правки", async () => {
    (analyzeReportReply as jest.Mock).mockResolvedValueOnce({ isReport: false, summary: "" });

    await expect(suggestFields("e-1", "report")).resolves.toEqual({
      text: "Ответ подготовлен и отправлен",
      source: "none"
    });
  });
});
