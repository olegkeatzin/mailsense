/**
 * Проверка доступности ИИ-эндпоинта: пользователь жмёт «Проверить» в настройках
 * и должен увидеть либо список моделей, либо понятную причину отказа.
 */
const mockList = jest.fn();
const mockOpenAI = jest.fn(() => ({ models: { list: mockList } }));

jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

import { testAiConnection } from "./models.js";

beforeEach(() => {
  mockList.mockReset();
  mockOpenAI.mockClear();
});

describe("успешная проверка", () => {
  test("возвращается отсортированный список моделей", async () => {
    mockList.mockResolvedValue({ data: [{ id: "qwen" }, { id: "glm-ocr" }, { id: "ornith" }] });
    const res = await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k" });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["glm-ocr", "ornith", "qwen"]);
  });

  test("пустые и нестроковые идентификаторы отбрасываются", async () => {
    mockList.mockResolvedValue({ data: [{ id: "ok" }, { id: "" }, {}, { id: 42 }] });
    const res = await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k" });
    expect(res.models).toEqual(["ok"]);
  });

  test("эндпоинт без моделей — это не ошибка", async () => {
    mockList.mockResolvedValue({});
    const res = await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k" });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([]);
  });
});

describe("параметры клиента", () => {
  test("пустой ключ заменяется заглушкой — llama.cpp её не требует", async () => {
    mockList.mockResolvedValue({ data: [] });
    await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "" });
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "not-needed" }));
  });

  test("таймаут по умолчанию и без повторов", async () => {
    mockList.mockResolvedValue({ data: [] });
    await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k" });
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30000, maxRetries: 0 }));
  });

  test("заданный таймаут применяется", async () => {
    mockList.mockResolvedValue({ data: [] });
    await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k", timeoutMs: 5000 });
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5000 }));
  });
});

describe("отказы", () => {
  test("ошибка соединения возвращается текстом, а не исключением", async () => {
    mockList.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await testAiConnection({ baseUrl: "http://нет.test/v1", apiKey: "k" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  test("не-ошибка в reject тоже даёт читаемый текст", async () => {
    mockList.mockRejectedValue("строка вместо ошибки");
    const res = await testAiConnection({ baseUrl: "http://ai.test/v1", apiKey: "k" });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
