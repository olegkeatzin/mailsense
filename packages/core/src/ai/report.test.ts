/**
 * Разбор ответа модели при распознавании отчёта.
 *
 * Главное свойство: **любая непонятность — это «не отчёт»**. Молчание безопаснее ложного
 * срабатывания: пропущенный отчёт аппарат увидит в почте, а закрытое по ошибке поручение — нет.
 */
const mockCreate = jest.fn();
const mockOpenAI = jest.fn(() => ({ chat: { completions: { create: mockCreate } } }));

jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

import { analyzeReportReply, parseReportAnalysis, REPORT_PROMPT } from "./report.js";

const cfg = { baseUrl: "http://ai.test/v1", apiKey: "k", model: "Ornith-1.5", timeoutMs: 60000 };

describe("разбор ответа модели", () => {
  test("корректный отчёт распознаётся", () => {
    const r = parseReportAnalysis('{"is_report": true, "summary": "Ответ направлен партнёру"}');
    expect(r.isReport).toBe(true);
    expect(r.summary).toBe("Ответ направлен партнёру");
  });

  test("явное «не отчёт» так и читается", () => {
    const r = parseReportAnalysis('{"is_report": false, "summary": ""}');
    expect(r.isReport).toBe(false);
    expect(r.summary).toBe("");
  });

  test("JSON в разметке тоже разбирается", () => {
    // Модели любят оборачивать ответ в ```-блок, хотя просили строгий JSON.
    const r = parseReportAnalysis('```json\n{"is_report": true, "summary": "Готово"}\n```');
    expect(r.isReport).toBe(true);
    expect(r.summary).toBe("Готово");
  });

  test("текст вокруг JSON не мешает", () => {
    const r = parseReportAnalysis('Вот результат: {"is_report": true, "summary": "Направил"} — как-то так');
    expect(r.isReport).toBe(true);
  });

  test("мусор вместо JSON — это «не отчёт», а не падение", () => {
    expect(parseReportAnalysis("Не могу разобрать").isReport).toBe(false);
    expect(parseReportAnalysis("{сломано").isReport).toBe(false);
    expect(parseReportAnalysis("").isReport).toBe(false);
  });

  test("отчёт без описания не принимается", () => {
    // Аппарату нечего проверять: пустая выжимка бесполезна.
    expect(parseReportAnalysis('{"is_report": true, "summary": ""}').isReport).toBe(false);
    expect(parseReportAnalysis('{"is_report": true}').isReport).toBe(false);
    expect(parseReportAnalysis('{"is_report": true, "summary": "   "}').isReport).toBe(false);
  });

  test("is_report строкой не считается отчётом", () => {
    expect(parseReportAnalysis('{"is_report": "true", "summary": "Готово"}').isReport).toBe(false);
  });

  test("слишком длинная выжимка обрезается", () => {
    const long = "а".repeat(1000);
    const r = parseReportAnalysis(JSON.stringify({ is_report: true, summary: long }));
    expect(r.isReport).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(300);
  });
});

describe("запрос к модели", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockOpenAI.mockClear();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"is_report": true, "summary": "Сделано"}' } }] });
  });

  test("поручение и ответ уходят в модель", async () => {
    await analyzeReportReply(cfg, {
      documentNumber: "вх17",
      taskText: "Подготовить ответ партнёру",
      replyText: "Ответ подготовлен и направлен"
    });
    const msg = mockCreate.mock.calls[0][0].messages[1].content as string;
    expect(msg).toContain("вх17");
    expect(msg).toContain("Подготовить ответ партнёру");
    expect(msg).toContain("Ответ подготовлен и направлен");
  });

  test("параметры запроса заданы", async () => {
    await analyzeReportReply(cfg, { documentNumber: "вх1", taskText: "т", replyText: "о" });
    const req = mockCreate.mock.calls[0][0];
    expect(req.temperature).toBe(0);
    expect(req.response_format).toEqual({ type: "json_object" });
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test("пустой ответ модели — это «не отчёт»", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    const r = await analyzeReportReply(cfg, { documentNumber: "вх1", taskText: "т", replyText: "о" });
    expect(r.isReport).toBe(false);
  });

  test("ошибка модели пробрасывается — решает вызывающий код", async () => {
    // Скан ящика из-за этого падать не должен: хук ловит и логирует.
    mockCreate.mockRejectedValue(new Error("модель недоступна"));
    await expect(
      analyzeReportReply(cfg, { documentNumber: "вх1", taskText: "т", replyText: "о" })
    ).rejects.toThrow("модель недоступна");
  });
});

describe("инструкция модели", () => {
  test("перечисляет и отчёт, и то, что им не является", () => {
    expect(REPORT_PROMPT).toContain("ОТЧЁТОМ ОБ ИСПОЛНЕНИИ");
    expect(REPORT_PROMPT).toContain("НЕ отчёт");
  });

  test("запрещает выдумывать подробности", () => {
    expect(REPORT_PROMPT).toContain("не выдумывай");
  });
});