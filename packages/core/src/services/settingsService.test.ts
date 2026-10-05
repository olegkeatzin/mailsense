import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { like } from "drizzle-orm";
import {
  getAiConfig,
  getAllSettings,
  getAnalysisConcurrency,
  getOcrConfig,
  getOcrConcurrency,
  getPromptSettings,
  getSettingValue,
  setAiConfig,
  setPromptSettings,
  setSettingValue
} from "./settingsService.js";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from "../ai/prompt.js";

/**
 * Настройки ИИ правятся из интерфейса и должны перекрывать значения из окружения.
 * Ошибка здесь тихо уводит анализ на чужую модель или в облако.
 */
let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-settings-"));
  initApp({
    dataDir: dir,
    ai: {
      baseUrl: "http://config.test/v1",
      apiKey: "cfg-key",
      model: "cfg-model",
      multimodal: false,
      timeoutMs: 1234
    }
  });
});

afterAll(() => {
  // На Windows открытый файл базы не удаляется — сначала закрываем соединение.
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог уберёт система */
  }
});

beforeEach(() => {
  getDb().delete(settings).where(like(settings.key, "ai.%")).run();
});

describe("настройки ИИ", () => {
  test("без сохранённых настроек берутся значения из конфигурации", () => {
    const ai = getAiConfig();
    expect(ai.baseUrl).toBe("http://config.test/v1");
    expect(ai.model).toBe("cfg-model");
    expect(ai.multimodal).toBe(false);
    expect(ai.timeoutMs).toBe(1234);
  });

  test("сохранённые настройки перекрывают конфигурацию", () => {
    setAiConfig({ baseUrl: "http://ui.test/v1", model: "ui-model", multimodal: true });
    const ai = getAiConfig();
    expect(ai.baseUrl).toBe("http://ui.test/v1");
    expect(ai.model).toBe("ui-model");
    expect(ai.multimodal).toBe(true);
  });

  test("multimodal выключается обратно (не только включается)", () => {
    setAiConfig({ multimodal: true });
    expect(getAiConfig().multimodal).toBe(true);
    setAiConfig({ multimodal: false });
    expect(getAiConfig().multimodal).toBe(false);
  });

  test("пустые значения не затирают сохранённые", () => {
    setAiConfig({ baseUrl: "http://ui.test/v1" });
    setAiConfig({ baseUrl: "" });
    expect(getAiConfig().baseUrl).toBe("http://ui.test/v1");
  });
});

describe("OCR-модель", () => {
  test("без своей модели падает на основную", () => {
    setAiConfig({ baseUrl: "http://main.test/v1", model: "main-model" });
    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://main.test/v1");
    expect(ocr.model).toBe("main-model");
  });

  test("со своей моделью использует её", () => {
    setAiConfig({
      baseUrl: "http://main.test/v1",
      model: "main-model",
      ocrBaseUrl: "http://ocr.test/v1",
      ocrModel: "glm-ocr"
    });
    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://ocr.test/v1");
    expect(ocr.model).toBe("glm-ocr");
  });

  test("модель OCR может быть своей при общем адресе", () => {
    setAiConfig({ baseUrl: "http://main.test/v1", model: "main-model", ocrBaseUrl: "", ocrModel: "glm-ocr" });
    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://main.test/v1");
    expect(ocr.model).toBe("glm-ocr");
  });
});

describe("параллельность", () => {
  test("значения по умолчанию", () => {
    expect(getAnalysisConcurrency()).toBe(1);
    expect(getOcrConcurrency()).toBe(3);
  });

  test("ноль и мусор не превращаются в бесконечность или NaN", () => {
    setSettingValue("ai.concurrency", "0");
    setSettingValue("ai.ocrConcurrency", "abc");
    expect(getAnalysisConcurrency()).toBe(1);
    expect(getOcrConcurrency()).toBe(3);
  });

  test("заданные значения применяются", () => {
    setSettingValue("ai.concurrency", "4");
    setSettingValue("ai.ocrConcurrency", "8");
    expect(getAnalysisConcurrency()).toBe(4);
    expect(getOcrConcurrency()).toBe(8);
  });
});

describe("промпты", () => {
  test("без настройки используются встроенные", () => {
    const p = getPromptSettings();
    expect(p.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(p.userTemplate).toBe(DEFAULT_USER_TEMPLATE);
  });

  test("сохранённые промпты читаются обратно", () => {
    setPromptSettings({ system: "Ты помощник.", userTemplate: "Письмо: {{text}}" });
    const p = getPromptSettings();
    expect(p.system).toBe("Ты помощник.");
    expect(p.userTemplate).toBe("Письмо: {{text}}");
  });
});

describe("произвольные настройки", () => {
  test("значение по умолчанию, когда ключа нет", () => {
    expect(getSettingValue("нет.такого.ключа", "запасное")).toBe("запасное");
  });

  test("сохранение и чтение", () => {
    setSettingValue("общий.ключ", "значение");
    expect(getSettingValue("общий.ключ")).toBe("значение");
  });

  test("полный список содержит сохранённое", () => {
    setSettingValue("общий.ключ", "значение");
    expect(getAllSettings()["общий.ключ"]).toBe("значение");
  });
});
