import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Защита от случайного закрытия года — на уровне маршрутов.
 *
 * Ядро (транзакции, блокировки, гонка) проверяется в docflow/yearGuard.test.ts.
 * Здесь — то, что видит человек: подтверждение годом, снимок ДО закрытия и отмена,
 * доступная только администратору. Сбой снимка обязан ОСТАНОВИТЬ закрытие: молча
 * закрыть год, не сохранив копию, нельзя.
 */
const mocked = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, TestUser> };
const coreMocks = core as unknown as Record<string, jest.Mock>;

const YEAR = "2026";
const token = (role: string) => "token:" + role;

let app: RunningApp;

beforeAll(async () => {
  for (const role of ["admin", "secretary", "executor"]) {
    mocked.__sessions.set(token(role), testUser("u-" + role, [role]));
  }
  // Роль настройщика без права на журнал: нумерацию ей менять можно (PUT — settings.manage),
  // значит и читать состояние она обязана.
  mocked.__sessions.set(token("settings"), testUser("u-settings", [], { permissions: ["settings.manage"] }));
  // Работник без прав документооборота: нумерация ему недоступна.
  mocked.__sessions.set(token("no-rights"), testUser("u-no-rights", [], { permissions: [] }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  // Иначе вызовы предыдущего теста остаются в моках и «не вызывался» врёт.
  jest.clearAllMocks();
  mocked.getNumberingState.mockResolvedValue({
    rules: [],
    openPeriod: YEAR,
    archivedPeriods: [],
    reopenablePeriods: [],
    blockedReason: null
  });
  mocked.exportPeriodArchive.mockResolvedValue("/tmp/archives/journal-" + YEAR + "-20261006-120000.zip");
  mocked.closePeriod.mockImplementation(async (input: { period: string; fileName?: string; documentCount?: number }) => ({
    period: input.period,
    fileName: input.fileName ?? "",
    documentCount: input.documentCount ?? 0
  }));
  mocked.reopenPeriod.mockImplementation(async (input: { period: string }) => ({ period: input.period }));
  // Документы журнала берутся из docflow (не из почтового ядра): 7 штук в году.
  mocked.listDocuments.mockResolvedValue({ items: [], total: 7 });
});

const archive = (body: unknown) =>
  request(app.baseUrl, "POST", "/api/docflow/numbering/archive", { token: token("secretary"), body });

const reopen = (body: unknown) =>
  request(app.baseUrl, "POST", "/api/docflow/numbering/reopen", { token: token("admin"), body });

describe("подтверждение годом проверяется на сервере", () => {
  it("без подтверждения закрытие отклонено и состояние не меняется", async () => {
    const res = await archive({ period: YEAR });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_confirm" });
    // Ничего не произошло: год не закрыт, архив не писался.
    expect(mocked.closePeriod).not.toHaveBeenCalled();
    expect(mocked.exportPeriodArchive).not.toHaveBeenCalled();
  });

  it("неверный год в подтверждении отклонён", async () => {
    const res = await archive({ period: YEAR, confirm: "2025" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_confirm" });
    expect(String((res.body as { error?: string }).error)).toContain(YEAR);
    expect(mocked.closePeriod).not.toHaveBeenCalled();
  });

  it("верный год: снимок делается ДО закрытия, и только потом год закрывается", async () => {
    const res = await archive({ period: YEAR, confirm: YEAR });

    expect(res.status).toBe(200);
    expect(mocked.exportPeriodArchive).toHaveBeenCalledWith(YEAR);
    expect(mocked.closePeriod).toHaveBeenCalledTimes(1);
    expect(mocked.closePeriod.mock.calls[0][0]).toMatchObject({ period: YEAR, documentCount: 7 });
    // Порядок важен: снимок обязан быть готов ДО необратимого действия.
    const snapshotOrder = mocked.exportPeriodArchive.mock.invocationCallOrder[0];
    const closeOrder = mocked.closePeriod.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(closeOrder);
  });
});

describe("сбой снимка останавливает закрытие", () => {
  it("выгрузка не удалась — год НЕ закрыт, и это сказано текстом сервера", async () => {
    mocked.exportPeriodArchive.mockRejectedValue(new Error("нет места на диске"));

    const res = await archive({ period: YEAR, confirm: YEAR });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "snapshot_failed" });
    const text = String((res.body as { error?: string }).error);
    expect(text).toContain("год НЕ закрыт");
    expect(text).toContain("нет места на диске");
    expect(text).toContain("Данные журнала не изменялись");
    // Главное: необратимое действие не выполнено.
    expect(mocked.closePeriod).not.toHaveBeenCalled();
  });

  it("ядро отказало в закрытии — причина доходит до человека, год не закрыт", async () => {
    mocked.closePeriod.mockRejectedValue(
      new (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError(
        "Во время выгрузки в 2026 году появились новые документы (8 вместо 7): архив неполный.",
        409,
        "period_changed"
      )
    );

    const res = await archive({ period: YEAR, confirm: YEAR });

    expect(res.status).toBe(409);
    expect(String((res.body as { error?: string }).error)).toContain("год НЕ закрыт");
    expect(String((res.body as { error?: string }).error)).toContain("архив неполный");
  });
});

describe("отмена закрытия года", () => {
  it("отмену делает только администратор", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/numbering/reopen", {
      token: token("secretary"),
      body: { period: YEAR, confirm: YEAR, reason: "ошиблись" }
    });

    expect(res.status).toBe(403);
    expect(mocked.reopenPeriod).not.toHaveBeenCalled();
  });

  it("причина обязательна", async () => {
    const res = await reopen({ period: YEAR, confirm: YEAR, reason: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_reason" });
    expect(mocked.reopenPeriod).not.toHaveBeenCalled();
  });

  it("год в подтверждении обязателен и здесь", async () => {
    const res = await reopen({ period: YEAR, reason: "ошиблись" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_confirm" });
    expect(mocked.reopenPeriod).not.toHaveBeenCalled();
  });

  it("верные данные: отмена уходит в ядро с причиной", async () => {
    const res = await reopen({ period: YEAR, confirm: YEAR, reason: "закрыли по ошибке" });

    expect(res.status).toBe(200);
    expect(mocked.reopenPeriod).toHaveBeenCalledWith({ period: YEAR, reason: "закрыли по ошибке" }, expect.anything());
  });

  it("отказ ядра показывается человеку текстом сервера, а не выдумывается клиентом", async () => {
    mocked.reopenPeriod.mockRejectedValue(
      new (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError(
        "В 2027 году уже зарегистрированы документы: номера выданы, отменить закрытие 2026 года нельзя.",
        409,
        "reopen_not_allowed"
      )
    );

    const res = await reopen({ period: YEAR, confirm: YEAR, reason: "передумали" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "reopen_not_allowed" });
    expect(String((res.body as { error?: string }).error)).toContain("2027");
  });
});

describe("состояние нумерации отдаёт подсказки для формы", () => {
  it("есть годы для отмены, размер архива и предел", async () => {
    mocked.getNumberingState.mockResolvedValue({
      rules: [],
      openPeriod: YEAR,
      archivedPeriods: [YEAR],
      reopenablePeriods: [YEAR],
      blockedReason: null
    });

    const res = await request(app.baseUrl, "GET", "/api/docflow/numbering", { token: token("admin") });

    expect(res.status).toBe(200);
    // Предела 4 ГБ больше нет (Zip64), поэтому и полей про предел/предупреждение нет:
    // предупреждать о несуществующем пределе — врать.
    const body = res.body as { reopenablePeriods: string[]; archiveLimitBytes?: number; archiveWarning?: unknown };
    expect(body.reopenablePeriods).toEqual([YEAR]);
    expect(body.archiveLimitBytes).toBeUndefined();
    expect(body.archiveWarning).toBeUndefined();
  });

  it("настройщик без права на журнал читает нумерацию: иначе вкладки не будет", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/numbering", { token: token("settings") });

    expect(res.status).toBe(200);
    expect(mocked.getNumberingState).toHaveBeenCalled();
  });

  it("работнику без прав документооборота состояние нумерации закрыто", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/numbering", { token: token("no-rights") });

    expect(res.status).toBe(403);
  });
});
