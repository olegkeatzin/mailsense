/** @jest-environment jsdom */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

// antd-карточки с формами в jsdom собираются медленно: 1000 мс по умолчанию не хватает.
configure({ asyncUtilTimeout: 8000 });

jest.mock("../api", () => ({
  resolutionApi: {
    forApproval: jest.fn(),
    forConfirmation: jest.fn(),
    executorCandidates: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
    confirm: jest.fn(),
    // Форма срока теперь показывает типовые сроки (А9) — маршрут должен быть в моке.
    deadlinePresets: jest.fn().mockResolvedValue({ items: [] })
  }
}));

import { resolutionApi } from "../api";
import { ApprovalList } from "../components/ApprovalList";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const initial = undefined;

const resolution = {
  id: "res-1",
  documentNumber: "вх38",
  text: "Петровой М.А. подготовить ответ внешнему партнёру.",
  status: "pending_approval",
  priority: "normal",
  deadline: "2026-10-20",
  assignees: [{ userId: "u-1", kind: "responsible", fullName: "Мария Петрова" }],
  history: [],
  preparedByName: "Иван Иванов"
} as unknown as Parameters<typeof Object>[0];

/**
 * Подписант решает судьбу поручения одним нажатием, и отменить это нельзя:
 * значит перед отправкой он должен увидеть, ЧТО именно утверждает.
 */
describe("ApprovalList: утверждение спрашивает подтверждение", () => {
  beforeAll(installDomEnvironment);

  // Компонент с запросами и модалками: без явной очистки DOM предыдущего теста
  // попадает в следующий и findByText находит чужую карточку.
  afterEach(() => cleanup());

  beforeEach(() => {
    jest.clearAllMocks();
    // Базовое состояние файла — роль подписанта; иначе состояние протекает между тестами.
    useStore.setState({
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "resolution.approve"], roles: ["signer"] } as unknown as AuthUser
    });
    (resolutionApi.forApproval as jest.Mock).mockResolvedValue({ items: [resolution], total: 1 });
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([
      { id: "u-1", fullName: "Мария Петрова", email: "petrova_ma@mail.test", department: "" }
    ]);
    (resolutionApi.approve as jest.Mock).mockResolvedValue({});
  });

  it("«Утвердить» сначала показывает, что уйдёт, и не отправляет запрос", async () => {
    render(<ApprovalList />);

    fireEvent.click(await screen.findByRole("button", { name: "Утвердить" }));

    // Подтверждение с сутью решения: текст, исполнитель, срок.
    const dialog = await waitFor(() => {
      const el = document.querySelector(".ant-modal-confirm");
      if (!el) throw new Error("нет подтверждения");
      return el as HTMLElement;
    });
    expect(dialog.textContent).toContain("Утвердить поручение");
    expect(dialog.textContent).toContain("Петровой М.А. подготовить ответ внешнему партнёру.");
    expect(dialog.textContent).toContain("Мария Петрова");
    expect(dialog.textContent).toContain("20.10.2026");
    // Пока не подтвердили — запроса нет.
    expect(resolutionApi.approve).not.toHaveBeenCalled();
  });

  it("подписанту не показывают кнопку аппарата «Подтвердить утверждение» (D4)", async () => {
    (resolutionApi.forApproval as jest.Mock).mockResolvedValue({
      items: [{ ...resolution, status: "email_approval" }],
      total: 1
    });
    render(<ApprovalList />);

    // Ждём именно текущую карточку (в body остаются порталы прошлых тестов).
    expect(await screen.findByText(/Подтверждает аппарат/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Подтвердить утверждение" })).toBeNull();
  });

  it("аппарат подтверждает разбор: кнопка на месте при resolution.dispatch", async () => {
    useStore.setState({
      authUser: { permissions: ["journal.view", "resolution.dispatch", "resolution.create"], roles: ["clerk"] } as unknown as AuthUser
    });
    (resolutionApi.forConfirmation as jest.Mock).mockResolvedValue({
      items: [{ ...resolution, status: "email_approval" }],
      total: 1
    });
    render(<ApprovalList mode="confirm" />);

    expect(await screen.findByRole("button", { name: "Подтвердить утверждение" })).not.toBeNull();
  });

  it("роль signer: очередь и справочник исполнителей доступны по её правам", async () => {
    useStore.setState({
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "resolution.approve"], roles: ["signer"] } as unknown as AuthUser
    });
    render(<ApprovalList />);

    expect(await screen.findByRole("button", { name: "Утвердить" })).not.toBeNull();
    expect(resolutionApi.forApproval).toHaveBeenCalled();
    // Справочник людей требует resolution.create|approve — у signer право approve есть.
    expect(resolutionApi.executorCandidates).toHaveBeenCalled();
  });

  it("без права resolution.approve экран не грузит чужую очередь", async () => {
    useStore.setState({
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["task.view", "task.report"], roles: ["executor"] } as unknown as AuthUser
    });
    render(<ApprovalList />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(resolutionApi.forApproval).not.toHaveBeenCalled();
    expect(resolutionApi.executorCandidates).not.toHaveBeenCalled();
  });

  it("подтверждение отправляет утверждение", async () => {
    render(<ApprovalList />);
    fireEvent.click(await screen.findByRole("button", { name: "Утвердить" }));
    const dialog = await waitFor(() => document.querySelector(".ant-modal-confirm") as HTMLElement);

    const ok = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Утвердить");
    fireEvent.click(ok!);

    await waitFor(() => expect(resolutionApi.approve).toHaveBeenCalledTimes(1));
    expect((resolutionApi.approve as jest.Mock).mock.calls[0][0]).toBe("res-1");
    expect(initial).toBeUndefined();
  });
});
