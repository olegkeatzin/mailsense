/**
 * Планировщик авто-проверки почты. Главное правило: он НЕ сканирует ящик целиком —
 * только письма от последней синхронизации. Иначе на большом ящике авто-скан
 * выглядел бы как зависание.
 */
const mockGetAccounts = jest.fn();
const mockFetchEmails = jest.fn();
const mockIsFetching = jest.fn();
const mockGetSettingValue = jest.fn();

jest.mock("./accountService.js", () => ({
  __esModule: true,
  getAccounts: () => mockGetAccounts()
}));
jest.mock("./mailService.js", () => ({
  __esModule: true,
  fetchEmails: (...a: unknown[]) => mockFetchEmails(...a),
  isFetching: (...a: unknown[]) => mockIsFetching(...a)
}));
jest.mock("./settingsService.js", () => ({
  __esModule: true,
  getSettingValue: (...a: unknown[]) => mockGetSettingValue(...a)
}));

import { startMailScheduler, stopMailScheduler } from "./scheduler.js";

function account(id: string, settings: Record<string, unknown> = {}) {
  return { id, username: id + "@mail.test", settings };
}

/** Ждём, пока немедленный прогон планировщика завершится. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  stopMailScheduler();
  mockGetAccounts.mockReset();
  mockFetchEmails.mockReset();
  mockIsFetching.mockReset();
  mockGetSettingValue.mockReset();
  mockGetAccounts.mockReturnValue([]);
  mockFetchEmails.mockResolvedValue({ added: 0, skipped: 0 });
  mockIsFetching.mockReturnValue(false);
  mockGetSettingValue.mockImplementation((key: string, fallback = "") =>
    key === "auto_fetch" ? "true" : fallback
  );
});

afterEach(() => {
  stopMailScheduler();
});

describe("выключенная авто-проверка", () => {
  test("при auto_fetch=false почта не сканируется", async () => {
    mockGetSettingValue.mockImplementation((key: string, fallback = "") =>
      key === "auto_fetch" ? "false" : fallback
    );
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: "2026-03-10T12:00:00.000Z" })]);

    startMailScheduler();
    await flush();

    expect(mockFetchEmails).not.toHaveBeenCalled();
  });
});

describe("точка отсчёта", () => {
  test("без lastFetchAt аккаунт пропускается — весь ящик автоматом не качаем", async () => {
    mockGetAccounts.mockReturnValue([account("a", {})]);
    startMailScheduler();
    await flush();
    expect(mockFetchEmails).not.toHaveBeenCalled();
  });

  test("с lastFetchAt запрашивается диапазон с суточным запасом", async () => {
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: "2026-03-10T12:00:00.000Z" })]);
    startMailScheduler();
    await flush();

    expect(mockFetchEmails).toHaveBeenCalledWith("a", { since: "2026-03-09" });
  });

  test("испорченная дата не запускает скан", async () => {
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: "не дата" })]);
    startMailScheduler();
    await flush();
    expect(mockFetchEmails).not.toHaveBeenCalled();
  });

  test("нестроковый lastFetchAt игнорируется", async () => {
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: 42 })]);
    startMailScheduler();
    await flush();
    expect(mockFetchEmails).not.toHaveBeenCalled();
  });
});

describe("несколько аккаунтов", () => {
  test("уже сканируемый аккаунт пропускается", async () => {
    mockGetAccounts.mockReturnValue([
      account("busy", { lastFetchAt: "2026-03-10T12:00:00.000Z" }),
      account("free", { lastFetchAt: "2026-03-10T12:00:00.000Z" })
    ]);
    mockIsFetching.mockImplementation((id: string) => id === "busy");

    startMailScheduler();
    await flush();

    // Параллельный скан того же ящика даёт «Connection not available».
    expect(mockFetchEmails).toHaveBeenCalledTimes(1);
    expect(mockFetchEmails.mock.calls[0][0]).toBe("free");
  });

  test("ошибка одного аккаунта не мешает остальным", async () => {
    mockGetAccounts.mockReturnValue([
      account("bad", { lastFetchAt: "2026-03-10T12:00:00.000Z" }),
      account("good", { lastFetchAt: "2026-03-10T12:00:00.000Z" })
    ]);
    mockFetchEmails.mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("сервер недоступен");
      return { added: 1, skipped: 0 };
    });

    startMailScheduler();
    await flush();

    expect(mockFetchEmails).toHaveBeenCalledTimes(2);
  });
});

describe("управление планировщиком", () => {
  test("повторный запуск не создаёт второй таймер", async () => {
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: "2026-03-10T12:00:00.000Z" })]);
    startMailScheduler();
    await flush();
    startMailScheduler(); // второй вызов должен быть проигнорирован
    await flush();

    expect(mockFetchEmails).toHaveBeenCalledTimes(1);
  });

  test("после остановки повторный старт снова работает", async () => {
    mockGetAccounts.mockReturnValue([account("a", { lastFetchAt: "2026-03-10T12:00:00.000Z" })]);
    startMailScheduler();
    await flush();
    stopMailScheduler();

    startMailScheduler();
    await flush();
    expect(mockFetchEmails).toHaveBeenCalledTimes(2);
  });

  test("остановка без запуска не падает", () => {
    expect(() => stopMailScheduler()).not.toThrow();
  });
});
