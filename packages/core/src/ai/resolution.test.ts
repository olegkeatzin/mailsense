/**
 * Черновик резолюции. Модель подменена: проверяем, что в неё уходит письмо целиком
 * и что мы не позволяем ей назначать исполнителей и срок.
 */
const mockCreate = jest.fn();
const mockOpenAI = jest.fn(() => ({ chat: { completions: { create: mockCreate } } }));

jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

import { draftResolution, RESOLUTION_PROMPT, type ResolutionDraftInput } from "./resolution.js";

const cfg = { baseUrl: "http://ai.test/v1", apiKey: "k", model: "Ornith-1.5", timeoutMs: 60000 };

function input(over: Partial<ResolutionDraftInput> = {}): ResolutionDraftInput {
  return {
    subject: "Об участии в марафоне",
    from: "АО «ОПК» <do@opkrt.ru>",
    summary: "Приглашение к участию, заявка до 07.09.2026",
    bodyText: "Просим подготовить и направить заявку до 07.09.2026.",
    attachmentTexts: [],
    ...over
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockOpenAI.mockClear();
  mockCreate.mockResolvedValue({ choices: [{ message: { content: "1. Рассмотреть участие.\n2. Подготовить заявку." } }] });
});

describe("запрос к модели", () => {
  test("в модель уходит письмо целиком", async () => {
    await draftResolution(cfg, input());
    const msg = mockCreate.mock.calls[0][0].messages[1].content as string;
    expect(msg).toContain("Об участии в марафоне");
    expect(msg).toContain("АО «ОПК»");
    expect(msg).toContain("заявка до 07.09.2026");
    expect(msg).toContain("Просим подготовить и направить заявку");
  });

  test("текст вложений тоже передаётся", async () => {
    await draftResolution(cfg, input({ attachmentTexts: ["Форма заявки: ФИО, подразделение"] }));
    const msg = mockCreate.mock.calls[0][0].messages[1].content as string;
    expect(msg).toContain("Форма заявки");
  });

  test("в модель уходит системная инструкция", async () => {
    await draftResolution(cfg, input());
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe(RESOLUTION_PROMPT);
  });

  test("модель и параметры заданы", async () => {
    await draftResolution(cfg, input());
    const req = mockCreate.mock.calls[0][0];
    expect(req.model).toBe("Ornith-1.5");
    expect(req.temperature).toBe(0);
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test("пустой ключ заменяется заглушкой", async () => {
    await draftResolution({ ...cfg, apiKey: "" }, input());
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "not-needed" }));
  });
});

describe("инструкция модели", () => {
  test("запрещает выдумывать факты", () => {
    expect(RESOLUTION_PROMPT).toContain("Не выдумывай");
  });

  test("запрещает назначать исполнителей по фамилиям", () => {
    expect(RESOLUTION_PROMPT).toContain("НЕ указывай исполнителей");
  });

  test("запрещает назначать срок исполнения", () => {
    expect(RESOLUTION_PROMPT).toContain("НЕ назначай срок");
  });

  test("требует нумерованный список без вступлений", () => {
    expect(RESOLUTION_PROMPT).toContain("Нумерованный список");
    expect(RESOLUTION_PROMPT).toContain("только текст резолюции");
  });
});

describe("ответ модели", () => {
  test("текст черновика возвращается без лишних пробелов", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "  1. Поручение.  " } }] });
    expect(await draftResolution(cfg, input())).toBe("1. Поручение.");
  });

  test("пустой ответ даёт пустую строку, а не «undefined»", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    expect(await draftResolution(cfg, input())).toBe("");
  });

  test("ошибка модели пробрасывается — решает вызывающий код", async () => {
    mockCreate.mockRejectedValue(new Error("модель недоступна"));
    await expect(draftResolution(cfg, input())).rejects.toThrow("модель недоступна");
  });
});