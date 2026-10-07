/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {},
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

import { notificationApi } from "../api";
import { NotificationsBell } from "../components/NotificationsBell";
import { useStore } from "../store";
import type { AppNotification, AuthStatus, AuthUser } from "../types";

const mockList = notificationApi.list as unknown as jest.Mock;
const mockCount = notificationApi.count as unknown as jest.Mock;
const mockMarkRead = notificationApi.markRead as unknown as jest.Mock;
const mockReadAll = notificationApi.readAll as unknown as jest.Mock;

const initial = useStore.getState();

function note(id: string, patch: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    kind: "resolution.assigned",
    entityType: "resolution",
    entityId: "res-" + id,
    title: "Новое поручение " + id,
    body: "Подготовить ответ внешнему партнёру",
    severity: "info",
    createdAt: new Date().toISOString(),
    readAt: null,
    deadline: null,
    daysLeft: null,
    link: "tasks",
    ...patch
  };
}

const page = (items: AppNotification[], total?: number, enabled = true) => ({
  items,
  unread: items.filter((n) => !n.readAt).length,
  total: total ?? items.length,
  enabled
});

function asUser(permissions: string[]) {
  useStore.setState({
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["executor"] } as unknown as AuthUser,
    section: "mail"
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

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /Уведомления/ }));

describe("колокольчик уведомлений", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    resetStore();
    mockList.mockResolvedValue(page([]));
    mockCount.mockResolvedValue({ unread: 0, enabled: true });
    mockMarkRead.mockResolvedValue({ ok: true, unread: 0 });
    mockReadAll.mockResolvedValue({ updated: 0, unread: 0 });
  });

  afterEach(() => {
    useStore.getState().stopNotificationPolling();
    jest.useRealTimers();
  });

  it("без права notifications.view колокольчика нет и счётчик не опрашивается", async () => {
    asUser(["task.view"]);
    jest.useFakeTimers();
    render(<NotificationsBell />);

    expect(screen.queryByRole("button", { name: /Уведомления/ })).toBeNull();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("без непрочитанных бейдж скрыт, а aria-label говорит словами", async () => {
    asUser(["notifications.view"]);
    mockCount.mockResolvedValue({ unread: 0, enabled: true });
    render(<NotificationsBell />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Уведомления/ }).getAttribute("aria-label")).toBe(
        "Уведомления, непрочитанных нет"
      )
    );
    expect(screen.queryByText("0")).toBeNull();
  });

  it("aria-label называет число непрочитанных", async () => {
    asUser(["notifications.view"]);
    mockCount.mockResolvedValue({ unread: 7, enabled: true });
    render(<NotificationsBell />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Уведомления/ }).getAttribute("aria-label")).toBe(
        "Уведомления, непрочитанных: 7"
      )
    );
    expect(await screen.findByText("7")).not.toBeNull();
  });

  it("100+ показывается как 99+, а aria-label говорит «больше 99»", async () => {
    asUser(["notifications.view"]);
    mockCount.mockResolvedValue({ unread: 128, enabled: true });
    render(<NotificationsBell />);

    expect(await screen.findByText("99+")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Уведомления/ }).getAttribute("aria-label")).toBe(
      "Уведомления, непрочитанных больше 99"
    );
  });

  it("открытие панели грузит список и показывает уведомление", async () => {
    asUser(["notifications.view"]);
    mockList.mockResolvedValue(page([note("n1")]));
    mockCount.mockResolvedValue({ unread: 1, enabled: true });
    render(<NotificationsBell />);

    openPanel();

    expect(await screen.findByRole("dialog", { name: "Центр уведомлений" })).not.toBeNull();
    expect(await screen.findByText("Новое поручение n1")).not.toBeNull();
    expect(screen.getByText("Подготовить ответ внешнему партнёру")).not.toBeNull();
  });

  it("клик по уведомлению помечает прочитанным, закрывает панель и ведёт в раздел", async () => {
    // Ссылка ведёт в «Мои задачи» — значит право task.view у пользователя есть.
    asUser(["notifications.view", "task.view"]);
    mockList.mockResolvedValue(page([note("n1", { link: "tasks" })]));
    mockMarkRead.mockResolvedValue({ ok: true, unread: 0 });
    render(<NotificationsBell />);

    openPanel();
    fireEvent.click(await screen.findByText("Новое поручение n1"));

    await waitFor(() => expect(useStore.getState().section).toBe("tasks"));
    expect(mockMarkRead).toHaveBeenCalledWith("n1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Уведомления/ }).getAttribute("aria-expanded")).toBe("false")
    );
  });

  it("уведомление без link не притворяется переходом: есть кнопка «Отметить прочитанным»", async () => {
    asUser(["notifications.view"]);
    useStore.setState({ section: "board" });
    mockList.mockResolvedValue(page([note("n1", { link: null })]));
    render(<NotificationsBell />);

    openPanel();
    const mark = await screen.findByRole("button", { name: /Отметить уведомление прочитанным/ });
    fireEvent.click(mark);

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith("n1"));
    expect(useStore.getState().section).toBe("board");
  });

  it("Esc закрывает панель", async () => {
    asUser(["notifications.view"]);
    render(<NotificationsBell />);

    openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Центр уведомлений" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Уведомления/ }).getAttribute("aria-expanded")).toBe("false")
    );
  });

  it("«прочитать все» вызывает серверное действие и обнуляет счётчик", async () => {
    asUser(["notifications.view"]);
    useStore.setState({ unreadCount: 2 });
    mockList.mockResolvedValue(page([note("n1"), note("n2")]));
    mockCount.mockResolvedValue({ unread: 2, enabled: true });
    mockReadAll.mockResolvedValue({ updated: 2, unread: 0 });
    render(<NotificationsBell />);

    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Прочитать все" }));

    await waitFor(() => expect(mockReadAll).toHaveBeenCalledTimes(1));
    expect(useStore.getState().unreadCount).toBe(0);
  });

  it("фильтр «только непрочитанные» перезапрашивает список с сервера", async () => {
    asUser(["notifications.view"]);
    mockList.mockResolvedValue(page([note("n1")]));
    render(<NotificationsBell />);

    openPanel();
    await screen.findByText("Новое поручение n1");
    mockList.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Только непрочитанные" }));

    await waitFor(() => expect(mockList).toHaveBeenCalledWith({ limit: 20, unreadOnly: true }));
  });

  it("пустое состояние говорит, где появятся уведомления", async () => {
    asUser(["notifications.view"]);
    render(<NotificationsBell />);

    openPanel();

    expect(await screen.findByText("Уведомлений пока нет")).not.toBeNull();
    expect(
      screen.getByText("Здесь появятся поручения, сроки и решения по вашим документам.")
    ).not.toBeNull();
  });

  it("пусто при фильтре — честный текст и кнопка «Показать все уведомления»", async () => {
    asUser(["notifications.view"]);
    mockList.mockResolvedValue(page([note("n1")]));
    render(<NotificationsBell />);

    openPanel();
    await screen.findByText("Новое поручение n1");
    mockList.mockResolvedValue(page([]));
    fireEvent.click(screen.getByRole("checkbox", { name: "Только непрочитанные" }));

    expect(await screen.findByText("Непрочитанных нет")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Показать все уведомления" })).not.toBeNull();
  });

  it("уведомления выключены администратором — об этом сказано прямо (А4)", async () => {
    asUser(["notifications.view"]);
    mockList.mockResolvedValue({ items: [], unread: 0, total: 0, enabled: false });
    render(<NotificationsBell />);

    openPanel();

    expect(await screen.findByText("Уведомления отключены администратором")).not.toBeNull();
  });

  it("ошибка загрузки показывается с кнопкой «Повторить»", async () => {
    asUser(["notifications.view"]);
    mockList.mockRejectedValueOnce(new Error("502 Bad Gateway"));
    render(<NotificationsBell />);

    openPanel();

    expect(await screen.findByText("Не удалось загрузить уведомления")).not.toBeNull();
    // Сбой объясняется по-русски, сырой ответ сервера — рядом в скобках (F9).
    expect(screen.getByText(/Сервер вернул ошибку \(502 Bad Gateway\)/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Повторить" })).not.toBeNull();
  });

  it("длинный список честно говорит «Показаны 20 из 137» и даёт «Показать ещё»", async () => {
    asUser(["notifications.view"]);
    const items = Array.from({ length: 20 }, (_, i) => note("n" + i));
    mockList.mockResolvedValue(page(items, 137));
    render(<NotificationsBell />);

    openPanel();

    expect(await screen.findByText("Показаны 20 из 137")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Показать ещё" })).not.toBeNull();
    expect(screen.getByText(/Хранятся последние 500 уведомлений/)).not.toBeNull();
  });

  it("при размонтировании опрос останавливается — таймер не живёт после ухода", async () => {
    asUser(["notifications.view"]);
    jest.useFakeTimers();
    const view = render(<NotificationsBell />);
    await jest.advanceTimersByTimeAsync(60_000);
    const callsWhileMounted = mockCount.mock.calls.length;

    view.unmount();
    await jest.advanceTimersByTimeAsync(600_000);

    expect(callsWhileMounted).toBeGreaterThanOrEqual(2);
    expect(mockCount.mock.calls.length).toBe(callsWhileMounted);
  });
});
