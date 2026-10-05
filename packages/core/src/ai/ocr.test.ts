/**
 * OCR вызывается постранично для каждого изображения вложения.
 * Проверяем, что в модель уходит и картинка, и инструкция, а ответ не теряется.
 */
const mockCreate = jest.fn();
const mockOpenAI = jest.fn(() => ({ chat: { completions: { create: mockCreate } } }));

jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

import { ocrImage, OCR_PROMPT } from "./ocr.js";

const cfg = { baseUrl: "http://ocr.test/v1", apiKey: "k", model: "glm-ocr", timeoutMs: 60000 };

beforeEach(() => {
  mockCreate.mockReset();
  mockOpenAI.mockClear();
  mockCreate.mockResolvedValue({ choices: [{ message: { content: "распознанный текст" } }] });
});

describe("запрос OCR", () => {
  test("в модель уходят инструкция и изображение", async () => {
    await ocrImage(cfg, "data:image/png;base64,AAA");
    const body = mockCreate.mock.calls[0][0];
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: OCR_PROMPT });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
  });

  test("инструкция запрещает пересказ — иначе номер документа не найти", () => {
    expect(OCR_PROMPT).toContain("ТОЛЬКО содержимое документа");
    expect(OCR_PROMPT).toContain("Ничего не пересказывай");
  });

  test("используется заданная OCR-модель и детерминированные параметры", async () => {
    await ocrImage(cfg, "data:image/png;base64,AAA");
    const body = mockCreate.mock.calls[0][0];
    expect(body.model).toBe("glm-ocr");
    // temperature 0: распознавание не должно «фантазировать».
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });

  test("таймаут и ключ берутся из настроек", async () => {
    await ocrImage(cfg, "data:image/png;base64,AAA");
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "http://ocr.test/v1", timeout: 60000 }));
  });

  test("пустой ключ заменяется заглушкой", async () => {
    await ocrImage({ ...cfg, apiKey: "" }, "data:image/png;base64,AAA");
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "not-needed" }));
  });
});

describe("ответ", () => {
  test("распознанный текст возвращается", async () => {
    expect(await ocrImage(cfg, "data:image/png;base64,AAA")).toBe("распознанный текст");
  });

  test("пустой ответ не роняет конвейер", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    expect(await ocrImage(cfg, "data:image/png;base64,AAA")).toBe("");
  });

  test("ошибка модели пробрасывается — анализ решит, что делать", async () => {
    mockCreate.mockRejectedValue(new Error("модель недоступна"));
    await expect(ocrImage(cfg, "data:image/png;base64,AAA")).rejects.toThrow("модель недоступна");
  });
});
