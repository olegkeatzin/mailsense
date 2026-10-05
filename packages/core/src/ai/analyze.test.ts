import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiConfig } from "../config.js";

/**
 * Вызов модели — место, где ошибка стоит дорого: без json_object и без отключения
 * «размышлений» reasoning-модель отдаёт обрезанный или пустой ответ. Проверяем
 * именно тело запроса, а не только результат.
 */
const mockCreate = jest.fn();
const mockOpenAI = jest.fn(() => ({
  chat: { completions: { create: mockCreate } }
}));

jest.mock("openai", () => ({
  __esModule: true,
  default: mockOpenAI
}));

// Импорты статические: jest.mock поднимается выше них, поэтому подмена срабатывает.
import { analyzeEmailRaw } from "./analyze.js";
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";

const cfg: AiConfig = {
  baseUrl: "http://ai.test/v1",
  apiKey: "test-key",
  model: "test-model",
  multimodal: true,
  timeoutMs: 5000
};

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-analyze-"));
  initApp({ dataDir: dir });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог уберёт система */
  }
});

beforeEach(() => {
  mockCreate.mockReset();
  mockOpenAI.mockClear();
  mockCreate.mockResolvedValue({ choices: [{ message: { content: "{\"summary\":\"ок\"}" } }] });
});

function input(over: Record<string, unknown> = {}) {
  return {
    subject: "Тема",
    from: "a@b.c",
    date: null,
    bodyText: "тело письма",
    attachmentTexts: [] as string[],
    attachmentNotes: [] as string[],
    images: [] as string[],
    attachmentNames: [] as string[],
    ...over
  };
}

describe("запрос к модели", () => {
  test("клиент создаётся с адресом, ключом и таймаутом из настроек", async () => {
    await analyzeEmailRaw(cfg, input());
    expect(mockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://ai.test/v1", apiKey: "test-key", timeout: 5000 })
    );
  });

  test("требует JSON и отключает «размышления» модели", async () => {
    await analyzeEmailRaw(cfg, input());
    const body = mockCreate.mock.calls[0][0];
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    // Без этого reasoning-модель тратит бюджет на рассуждение и возвращает пустоту.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(8192);
  });

  test("текст промпта уходит первым блоком, изображения — следом", async () => {
    await analyzeEmailRaw(
      cfg,
      input({ images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] })
    );
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("тело письма");
    expect(content).toHaveLength(3);
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
  });

  test("без изображений остаётся только текст", async () => {
    await analyzeEmailRaw(cfg, input());
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  test("тексты вложений попадают в промпт", async () => {
    await analyzeEmailRaw(cfg, input({ attachmentTexts: ["содержимое"], attachmentNames: ["doc.pdf"] }));
    const text = mockCreate.mock.calls[0][0].messages[0].content[0].text;
    expect(text).toContain("doc.pdf");
    expect(text).toContain("содержимое");
  });

  test("сигнал отмены пробрасывается в клиент", async () => {
    const ctrl = new AbortController();
    await analyzeEmailRaw(cfg, input(), ctrl.signal);
    expect(mockCreate.mock.calls[0][1]).toEqual({ signal: ctrl.signal });
  });
});

describe("ответ модели", () => {
  test("возвращается содержимое ответа", async () => {
    const out = await analyzeEmailRaw(cfg, input());
    expect(out).toBe("{\"summary\":\"ок\"}");
  });

  test("пустой ответ не роняет анализ", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    await expect(analyzeEmailRaw(cfg, input())).resolves.toBe("");
  });

  test("ответ без content даёт пустую строку, а не «undefined»", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: {} }] });
    await expect(analyzeEmailRaw(cfg, input())).resolves.toBe("");
  });

  test("ошибка клиента пробрасывается наверх", async () => {
    mockCreate.mockRejectedValue(new Error("модель недоступна"));
    await expect(analyzeEmailRaw(cfg, input())).rejects.toThrow("модель недоступна");
  });
});
