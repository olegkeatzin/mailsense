/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ api: {}, resolutionApi: { deadlinePresets: jest.fn() } }));

import { resolutionApi } from "../api";
import { DeadlinePresets } from "../components/DeadlinePresets";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const mockPresets = resolutionApi.deadlinePresets as unknown as jest.Mock;

/** Кто-то вошёл: права проверяются до запроса. */
function asUser(permissions: string[]) {
  useStore.setState({
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["x"] } as unknown as AuthUser
  });
}

describe("подсказки срока (А9)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    // По умолчанию — подписант: у него есть resolution.approve.
    asUser(["journal.view", "resolution.approve"]);
  });

  it("чипы приходят с сервера и подставляют готовую дату", async () => {
    mockPresets.mockResolvedValue({
      items: [
        { id: "p1", title: "3 дня", days: 3, isWorkday: true, dueDate: "2026-10-12" },
        { id: "p2", title: "10 дней", days: 10, isWorkday: false, dueDate: "2026-10-20" }
      ]
    });
    const onPick = jest.fn();
    render(<DeadlinePresets onPick={onPick} />);

    expect(await screen.findByText("3 дня (3 раб. дн.)")).not.toBeNull();
    fireEvent.click(screen.getByText("10 дней (10 дн.)"));

    expect(onPick).toHaveBeenCalledWith("2026-10-20");
  });

  it("подписанту чипы доступны: маршрут открыт по resolution.approve (D4)", async () => {
    mockPresets.mockResolvedValue({
      items: [{ id: "p1", title: "3 дня", days: 3, isWorkday: true, dueDate: "2026-10-12" }]
    });
    render(<DeadlinePresets onPick={jest.fn()} />);

    expect(await screen.findByText("3 дня (3 раб. дн.)")).not.toBeNull();
    expect(mockPresets).toHaveBeenCalledTimes(1);
  });

  it("без прав ни запроса, ни чипов: срок вводится вручную (D4)", async () => {
    asUser(["journal.view", "task.view"]);
    mockPresets.mockResolvedValue({
      items: [{ id: "p1", title: "3 дня", days: 3, isWorkday: true, dueDate: "2026-10-12" }]
    });
    const { container } = render(<DeadlinePresets onPick={jest.fn()} />);

    await Promise.resolve();
    expect(mockPresets).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("пустой список — никаких пустых чипов", async () => {
    mockPresets.mockResolvedValue({ items: [] });
    const { container } = render(<DeadlinePresets onPick={jest.fn()} />);

    await waitFor(() => expect(mockPresets).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe("");
  });
});
