/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

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

  beforeEach(() => {
    jest.clearAllMocks();
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
