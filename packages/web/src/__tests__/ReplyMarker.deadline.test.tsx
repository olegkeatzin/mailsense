/** @jest-environment jsdom */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {},
  resolutionApi: {
    replyContext: jest.fn(),
    executorCandidates: jest.fn(),
    markApproval: jest.fn(),
    suggestFields: jest.fn(),
    confirmReport: jest.fn()
  }
}));

import { resolutionApi } from "../api";
import { ReplyMarker } from "../components/ReplyMarker";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

configure({ asyncUtilTimeout: 8000 });

const initial = useStore.getState();
const item = {
  resolutionId: "res-1",
  expects: "approval" as const,
  documentNumber: "вх38",
  documentSummary: "Обращение",
  taskText: "Подготовить ответ",
  assignees: [{ userId: "u-1", fullName: "Мария Петрова", kind: "responsible" as const }]
};

/**
 * Живой прогон QA: подписант набрал срок 12.10.2026 и нажал «Отметить и утвердить» —
 * в резолюции deadline остался null. Проверяем, теряется ли набранная дата.
 */
describe("срок в модалке «Резолюция руководителя»", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (resolutionApi.replyContext as jest.Mock).mockResolvedValue([item]);
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([
      { id: "u-1", fullName: "Мария Петрова", email: "p@mail.test", department: "" }
    ]);
    (resolutionApi.markApproval as jest.Mock).mockResolvedValue({});
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "resolution.dispatch"], roles: ["clerk"] } as unknown as AuthUser
    });
  });

  async function openModalAndFill() {
    render(<ReplyMarker emailId="e-1" onMarked={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Это резолюция руководителя" }));
    const textarea = await screen.findByPlaceholderText("Кому и что сделать");
    fireEvent.change(textarea, { target: { value: "Петровой подготовить ответ" } });
    return textarea;
  }

  it("набранная дата не теряется при нажатии кнопки (без Enter/blur)", async () => {
    await openModalAndFill();

    const input = screen.getByPlaceholderText("не указан");
    fireEvent.change(input, { target: { value: "12.10.2026" } });
    // Пользователь сразу нажимает кнопку — как в живом прогоне.
    fireEvent.click(screen.getByRole("button", { name: "Отметить и утвердить" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    const payload = (resolutionApi.markApproval as jest.Mock).mock.calls[0][1];
    expect(payload.deadline).toBe("2026-10-12");
  });

  it("ISO-ввод «2026-10-12» тоже доходит до сервера", async () => {
    await openModalAndFill();

    const input = screen.getByPlaceholderText("не указан");
    fireEvent.change(input, { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Отметить и утвердить" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    expect((resolutionApi.markApproval as jest.Mock).mock.calls[0][1].deadline).toBe("2026-10-12");
  });

  it("срок не вводили — на сервер уходит null, а не выдуманная дата", async () => {
    await openModalAndFill();

    fireEvent.click(screen.getByRole("button", { name: "Отметить и утвердить" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    expect((resolutionApi.markApproval as jest.Mock).mock.calls[0][1].deadline).toBeNull();
  });
});
