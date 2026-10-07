import { loadAiModelList } from "../utils/aiModels";

/**
 * Список моделей ИИ — необязательная подсказка. Его отказ не должен рождать
 * необработанный отказ промиса (класс, из-за которого уже обжигались на /api/ai/config):
 * тогда в консоли при обычном пользователе было бы «UnhandledPromiseRejection».
 */
describe("подсказка моделей ИИ: отказ не ломает форму", () => {
  it("отказ запроса превращается в пустой список, а не в отказ промиса", async () => {
    const failing = jest.fn().mockRejectedValue(new Error("502 Bad Gateway"));

    await expect(loadAiModelList(failing, "http://ai.test:8080", "k")).resolves.toEqual([]);
    expect(failing).toHaveBeenCalledWith({ baseUrl: "http://ai.test:8080", apiKey: "k" });
  });

  it("успешный ответ отдаёт модели, а «не ок» — пусто", async () => {
    const ok = jest.fn().mockResolvedValue({ ok: true, models: ["llama", "qwen"] });
    await expect(loadAiModelList(ok, "http://ai.test:8080")).resolves.toEqual(["llama", "qwen"]);

    const notOk = jest.fn().mockResolvedValue({ ok: false });
    await expect(loadAiModelList(notOk, "http://ai.test:8080")).resolves.toEqual([]);
  });

  it("без адреса запроса нет вовсе", async () => {
    const spy = jest.fn();
    await expect(loadAiModelList(spy, "")).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
