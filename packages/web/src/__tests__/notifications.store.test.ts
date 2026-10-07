/** @jest-environment jsdom */
import { notificationApi } from "../api";
import { useStore } from "../store";
import type { AppNotification, AuthStatus, AuthUser } from "../types";

jest.mock("../api", () => ({
  api: {},
  resolutionApi: {},
  notificationApi: {
    list: jest.fn(),
    count: jest.fn(),
    markRead: jest.fn(),
    readAll: jest.fn(),
    settings: jest.fn(),
    saveSettings: jest.fn(),
    sortRules: jest.fn(),
    createSortRule: jest.fn(),
    updateSortRule: jest.fn(),
    deleteSortRule: jest.fn(),
    previewSortRule: jest.fn()
  }
}));

const mockList = notificationApi.list as unknown as jest.Mock;
const mockCount = notificationApi.count as unknown as jest.Mock;
const mockMarkRead = notificationApi.markRead as unknown as jest.Mock;
const mockReadAll = notificationApi.readAll as unknown as jest.Mock;

const initial = useStore.getState();

function notification(id: string, read = false): AppNotification {
  return {
    id,
    kind: "resolution.assigned",
    entityType: "resolution",
    entityId: "res-" + id,
    title: "Новое поручение",
    body: "Подготовить ответ",
    severity: "info",
    createdAt: "2026-10-07T09:00:00.000Z",
    readAt: read ? "2026-10-07T10:00:00.000Z" : null,
    deadline: null,
    daysLeft: null,
    link: "tasks"
  };
}

/** Промис, которым тест управляет вручную: нужно проверить, какой ответ «победит». */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function asUser(permissions: string[]) {
  useStore.setState({
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["executor"] } as unknown as AuthUser
  });
}

function resetStore() {
  useStore.getState().stopNotificationPolling();
  useStore.setState({
    ...initial,
    notifications: [],
    notificationsTotal: 0,
    notificationsEnabled: true,
    unreadCount: 0,
    notificationsError: null,
    notificationsLoading: false,
    notificationsForbidden: false
  });
}

const page = (items: AppNotification[], total?: number, enabled = true) => ({
  items,
  unread: items.filter((n) => !n.readAt).length,
  total: total ?? items.length,
  enabled
});

describe("опрос счётчика непрочитанных уведомлений", () => {
  beforeEach(() => {
    resetStore();
    mockCount.mockResolvedValue({ unread: 0, enabled: true });
  });

  afterEach(() => {
    useStore.getState().stopNotificationPolling();
    jest.useRealTimers();
  });

  it("без права notifications.view опроса нет вовсе — иначе 403 в консоли", async () => {
    asUser(["task.view", "task.report"]);
    jest.useFakeTimers();

    useStore.getState().startNotificationPolling();
    await jest.advanceTimersByTimeAsync(300_000);

    expect(mockCount).not.toHaveBeenCalled();
  });

  it("с правом счётчик берётся сразу и далее раз в 60 секунд", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();

    useStore.getState().startNotificationPolling();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCount).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockCount).toHaveBeenCalledTimes(2);
  });

  it("остановка опроса снимает таймер: после размонтирования запросов больше нет", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();

    useStore.getState().startNotificationPolling();
    await jest.advanceTimersByTimeAsync(1);
    useStore.getState().stopNotificationPolling();
    await jest.advanceTimersByTimeAsync(600_000);

    expect(mockCount).toHaveBeenCalledTimes(1);
  });

  it("повторный старт не удваивает опрос", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();

    useStore.getState().startNotificationPolling();
    useStore.getState().startNotificationPolling();
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockCount).toHaveBeenCalledTimes(2);
  });

  it("свёрнутая вкладка не опрашивается: результат всё равно никто не увидит", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true);

    useStore.getState().startNotificationPolling();
    // Первый (немедленный) запрос — до подмены: считаем только тики таймера.
    const immediate = mockCount.mock.calls.length;
    await jest.advanceTimersByTimeAsync(180_000);

    expect(mockCount.mock.calls.length).toBe(immediate);
    hidden.mockRestore();
  });

  it("сбой сети не останавливает опрос, а 403 — останавливает (право отозвали)", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();
    mockCount.mockRejectedValueOnce(new Error("502 Bad Gateway"));

    useStore.getState().startNotificationPolling();
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockCount).toHaveBeenCalledTimes(2);

    mockCount.mockRejectedValue(new Error("403 Forbidden"));
    await jest.advanceTimersByTimeAsync(60_000);
    const after403 = mockCount.mock.calls.length;
    await jest.advanceTimersByTimeAsync(300_000);

    expect(useStore.getState().notificationsForbidden).toBe(true);
    expect(mockCount.mock.calls.length).toBe(after403);
  });

  it("счётчик из ответа попадает в состояние", async () => {
    asUser(["notifications.view"]);
    mockCount.mockResolvedValue({ unread: 7, enabled: true });

    await useStore.getState().refreshUnreadCount();

    expect(useStore.getState().unreadCount).toBe(7);
  });

  it("ответ счётчика, начатый до «прочитать все», не возвращает старый счётчик", async () => {
    asUser(["notifications.view"]);
    const slow = deferred<{ unread: number; enabled: boolean }>();
    mockCount.mockReturnValueOnce(slow.promise);
    mockReadAll.mockResolvedValue({ updated: 3, unread: 0 });
    useStore.setState({ notifications: [notification("n1")], unreadCount: 3 });

    const inFlight = useStore.getState().refreshUnreadCount();
    await useStore.getState().markAllNotificationsRead();
    expect(useStore.getState().unreadCount).toBe(0);

    slow.resolve({ unread: 3, enabled: true });
    await inFlight;

    expect(useStore.getState().unreadCount).toBe(0);
  });
});

describe("действия с уведомлениями", () => {
  beforeEach(resetStore);

  it("загрузка списка кладёт уведомления, счётчик и общее число", async () => {
    mockList.mockResolvedValue({ ...page([notification("n1")], 137), unread: 1 });

    await useStore.getState().loadNotifications();

    expect(useStore.getState().notifications.map((n) => n.id)).toEqual(["n1"]);
    expect(useStore.getState().unreadCount).toBe(1);
    expect(useStore.getState().notificationsTotal).toBe(137);
  });

  it("страница по умолчанию — 20 записей, фильтр уходит на сервер", async () => {
    mockList.mockResolvedValue(page([]));

    await useStore.getState().loadNotifications({ unreadOnly: true });

    expect(mockList).toHaveBeenCalledWith({ limit: 20, unreadOnly: true });
  });

  it("«показать ещё» догружает следующую страницу, а не те же 20", async () => {
    const first = Array.from({ length: 20 }, (_, i) => notification("n" + i));
    useStore.setState({ notifications: first, notificationsTotal: 30 });
    mockList.mockResolvedValue(page(first.concat([notification("n20")]), 30));

    await useStore.getState().loadNotifications({ append: true });

    expect(mockList).toHaveBeenCalledWith({ limit: 40, unreadOnly: false });
  });

  it("признак «уведомления выключены» доходит до интерфейса (А4)", async () => {
    mockList.mockResolvedValue({ items: [], unread: 0, total: 0, enabled: false });

    await useStore.getState().loadNotifications();

    expect(useStore.getState().notificationsEnabled).toBe(false);
  });

  it("прочтение одного обновляет счётчик из ответа, а не догадкой", async () => {
    useStore.setState({ notifications: [notification("n1"), notification("n2")], unreadCount: 2 });
    mockMarkRead.mockResolvedValue({ ok: true, unread: 1 });

    await useStore.getState().markNotificationRead("n1");

    const items = useStore.getState().notifications;
    expect(items.find((n) => n.id === "n1")?.readAt).not.toBeNull();
    expect(items.find((n) => n.id === "n2")?.readAt).toBeNull();
    expect(useStore.getState().unreadCount).toBe(1);
  });

  it("отказ отметки прочитанным откатывает оптимистичную правку", async () => {
    useStore.setState({ notifications: [notification("n1")], unreadCount: 1 });
    mockMarkRead.mockRejectedValue(new Error("502 Bad Gateway"));

    await expect(useStore.getState().markNotificationRead("n1")).rejects.toThrow("502");

    expect(useStore.getState().notifications[0].readAt).toBeNull();
    expect(useStore.getState().unreadCount).toBe(1);
  });

  it("«прочитать все» обнуляет счётчик и помечает все строки", async () => {
    useStore.setState({ notifications: [notification("n1"), notification("n2")], unreadCount: 2 });
    mockReadAll.mockResolvedValue({ updated: 2, unread: 0 });

    await useStore.getState().markAllNotificationsRead();

    expect(useStore.getState().unreadCount).toBe(0);
    expect(useStore.getState().notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it("ошибка загрузки попадает в состояние, а не в необработанный промис", async () => {
    mockList.mockRejectedValue(new Error("403 Forbidden"));

    await expect(useStore.getState().loadNotifications()).resolves.toBeUndefined();

    const err = useStore.getState().notificationsError ?? "";
    expect(err).toContain("Недостаточно прав");
    expect(err).toContain("403 Forbidden");
    expect(useStore.getState().notificationsForbidden).toBe(true);
  });
});
