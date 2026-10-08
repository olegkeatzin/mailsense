import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { like } from "drizzle-orm";

/**
 * OCR может жить на ДРУГОМ сервере, чем выжимка, и задаётся это переменными окружения
 * (MAILSENSE_AI_OCR_BASE_URL / MAILSENSE_AI_OCR_MODEL) — в контейнере интерфейса нет.
 * Приоритет: настройка в базе (админ поменял через интерфейс) → переменная окружения → пусто.
 * Пустое значение = «не задано», тогда getOcrConfig падает на основную модель и адрес.
 */
import { initApp } from "../init.js";
import { closeDb, getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { getAiConfig, getOcrConfig, setAiConfig, setSettingValue } from "./settingsService.js";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-ocr-env-"));
  // Так выглядит конфиг, собранный из переменных окружения при старте.
  initApp({
    dataDir: dir,
    ai: {
      baseUrl: "http://summary.test/v1",
      apiKey: "k",
      model: "summary-model",
      multimodal: true,
      timeoutMs: 1000,
      ocrBaseUrl: "http://ocr-env.test/v1",
      ocrModel: "glm-ocr-env"
    }
  });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(() => {
  getDb().delete(settings).where(like(settings.key, "ai.%")).run();
});

describe("OCR-источник из переменных окружения", () => {
  test("без настройки в базе адрес и модель берутся из окружения", () => {
    expect(getAiConfig().ocrBaseUrl).toBe("http://ocr-env.test/v1");
    expect(getAiConfig().ocrModel).toBe("glm-ocr-env");

    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://ocr-env.test/v1");
    expect(ocr.model).toBe("glm-ocr-env");
  });

  test("настройка в базе перебивает окружение", () => {
    setAiConfig({ ocrBaseUrl: "http://ocr-ui.test/v1", ocrModel: "ui-ocr" });

    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://ocr-ui.test/v1");
    expect(ocr.model).toBe("ui-ocr");
  });

  test("пустая настройка в базе не перебивает окружение", () => {
    setSettingValue("ai.ocrBaseUrl", "   ");
    setSettingValue("ai.ocrModel", "");

    const ocr = getOcrConfig();
    expect(ocr.baseUrl).toBe("http://ocr-env.test/v1");
    expect(ocr.model).toBe("glm-ocr-env");
  });

  test("адрес OCR из окружения не подменяет адрес выжимки", () => {
    // Разные источники: выжимка и OCR ходят каждый на свой адрес.
    expect(getAiConfig().baseUrl).toBe("http://summary.test/v1");
    expect(getOcrConfig().baseUrl).toBe("http://ocr-env.test/v1");
  });
});
