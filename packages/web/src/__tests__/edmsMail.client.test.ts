/**
 * Тела запросов СЭД несут выбранный ящик (T53).
 *
 * Здесь НЕТ мока ../api: проверяем настоящий клиент и настоящий JSON, который уходит на сервер.
 */
import { resolutionApi } from "../api";

describe("клиент СЭД передаёт accountId (T53)", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forward/dispatch/report несут accountId; без выбора поля нет", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({})
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    await resolutionApi.forward("doc-1", "u-1", "acc-1").catch(() => null);
    await resolutionApi.dispatch("res-1", "acc-1").catch(() => null);
    await resolutionApi.report("res-1", "сделано", null, "acc-1").catch(() => null);
    await resolutionApi.forward("doc-1", "u-1").catch(() => null);

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies[0]).toEqual({ documentId: "doc-1", toUserId: "u-1", accountId: "acc-1" });
    expect(bodies[1]).toEqual({ accountId: "acc-1" });
    expect(bodies[2]).toEqual({ text: "сделано", emailId: null, accountId: "acc-1" });
    // Без выбранного ящика поле не подставляем: решает сервер (личная настройка работника).
    expect(bodies[3]).toEqual({ documentId: "doc-1", toUserId: "u-1" });
  });
});
