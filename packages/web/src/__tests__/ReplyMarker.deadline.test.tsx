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
 * Живой прогон QA: подписант набрал срок 12.10.2026 и нажал «Внести в журнал» —
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
    fireEvent.click(screen.getByRole("button", { name: "Внести в журнал" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    const payload = (resolutionApi.markApproval as jest.Mock).mock.calls[0][1];
    expect(payload.deadline).toBe("2026-10-12");
  });

  it("ISO-ввод «2026-10-12» тоже доходит до сервера", async () => {
    await openModalAndFill();

    const input = screen.getByPlaceholderText("не указан");
    fireEvent.change(input, { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Внести в журнал" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    expect((resolutionApi.markApproval as jest.Mock).mock.calls[0][1].deadline).toBe("2026-10-12");
  });

  it("срок не вводили — на сервер уходит null, а не выдуманная дата", async () => {
    await openModalAndFill();

    fireEvent.click(screen.getByRole("button", { name: "Внести в журнал" }));

    await waitFor(() => expect(resolutionApi.markApproval).toHaveBeenCalledTimes(1));
    expect((resolutionApi.markApproval as jest.Mock).mock.calls[0][1].deadline).toBeNull();
  });
});

/**
 * Руководитель ответил из Outlook: нашего текста резолюции нет, исполнителей он назвал
 * в копии письма. Аппарат должен увидеть и то, и другое — и поправить при желании.
 */
describe("ответ из Outlook: текст и исполнители из письма", () => {
  beforeAll(installDomEnvironment);

  const outlookItem = {
    resolutionId: "res-9",
    expects: "approval" as const,
    documentNumber: "вх2",
    documentSummary: "Спортивное мероприятие",
    taskText: "Организовать мероприятие",
    assignees: [],
    replyText: "Петрову и Иванову организовать мероприятие до 20.10",
    executorCandidates: [
      { address: "petrov@mail.test", name: "Петров" },
      { address: "unknown@mail.test", name: "Неизвестный" }
    ]
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (resolutionApi.replyContext as jest.Mock).mockResolvedValue([outlookItem]);
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([
      { id: "u-9", fullName: "Петров Пётр", email: "petrov@mail.test", department: "" }
    ]);
    (resolutionApi.markApproval as jest.Mock).mockResolvedValue({});
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["resolution.dispatch"], roles: ["clerk"] } as unknown as AuthUser
    });
  });

  it("показывает исполнителей из письма и подставляет текст ответа", async () => {
    render(<ReplyMarker emailId="e-9" onMarked={jest.fn()} />);

    expect(await screen.findByText(/В письме указаны исполнители: Петров, Неизвестный/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Это резолюция руководителя" }));
    const textarea = (await screen.findByPlaceholderText("Кому и что сделать")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Петрову и Иванову организовать мероприятие до 20.10");

    // Петрова (получателя из письма) система находит по адресу и отмечает сама.
    await waitFor(() => expect(screen.getByText(/Петров Пётр/)).not.toBeNull());
    // Безызвестный адрес не выдумываем — о нём честно предупреждаем.
    expect(screen.getByText(/которых нет в каталоге/)).not.toBeNull();
  });
});
