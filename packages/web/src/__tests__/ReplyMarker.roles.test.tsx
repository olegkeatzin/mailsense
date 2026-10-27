/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { journal: jest.fn().mockResolvedValue({ items: [], total: 0 }) },
  resolutionApi: {
    replyContext: jest.fn(),
    executorCandidates: jest.fn().mockResolvedValue([]),
    markApproval: jest.fn(),
    suggestFields: jest.fn(),
    confirmReport: jest.fn(),
    approve: jest.fn().mockResolvedValue({}),
    report: jest.fn().mockResolvedValue({}),
    createApprovedFromEmail: jest.fn().mockResolvedValue({}),
    forApproval: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    board: jest.fn().mockResolvedValue([]),
    myTasks: jest.fn().mockResolvedValue([])
  }
}));

import { api, resolutionApi } from "../api";
import { ReplyMarker } from "../components/ReplyMarker";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

/**
 * Этап пайплайна могли пройти в Outlook, а не в приложении. Руководитель и исполнитель
 * должны сами зарегистрировать свой шаг там, где открыто письмо.
 */
const initial = useStore.getState();

const approvalItem = {
  resolutionId: "res-1",
  expects: "approval" as const,
  documentNumber: "вх1",
  documentSummary: "Приглашение",
  taskText: "",
  assignees: [{ userId: "u-1", fullName: "Мария Петрова", kind: "responsible" as const }]
};

const reportItem = {
  ...approvalItem,
  expects: "report" as const,
  assignees: [{ userId: "u-executor", fullName: "Пётр Исполнитель", kind: "responsible" as const }]
};

function asUser(id: string, permissions: string[]) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { id, permissions, roles: [] } as unknown as AuthUser
  });
}

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([
    { id: "u-1", fullName: "Мария Петрова", email: "p@mail.test" }
  ]);
  (resolutionApi.approve as jest.Mock).mockResolvedValue({});
  (resolutionApi.report as jest.Mock).mockResolvedValue({});
});

it("руководитель сам утверждает резолюцию из письма", async () => {
  asUser("u-signer", ["journal.view", "resolution.approve"]);
  (resolutionApi.replyContext as jest.Mock).mockResolvedValue([approvalItem]);

  render(<ReplyMarker emailId="e-1" onMarked={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Это моя резолюция" }));
  fireEvent.change(await screen.findByPlaceholderText("Кому и что сделать"), {
    target: { value: "Петровой подготовить ответ" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Утвердить и отправить" }));

  await waitFor(() => expect(resolutionApi.approve).toHaveBeenCalledTimes(1));
  expect((resolutionApi.approve as jest.Mock).mock.calls[0][1].text).toContain("Петровой");
  expect((resolutionApi.approve as jest.Mock).mock.calls[0][1].sendEmail).toBe(true);
});

it("если тред не совпал, руководитель выбирает поручение вручную", async () => {
  asUser("u-signer", ["journal.view", "resolution.approve"]);
  (resolutionApi.replyContext as jest.Mock).mockResolvedValue([]);
  (resolutionApi.forApproval as jest.Mock).mockResolvedValue({
    items: [
      {
        ...approvalItem,
        id: "res-2",
        status: "pending_approval",
        documentNumber: "вх2",
        documentSummary: "Второе обращение",
        text: "Подготовить ответ",
        assignees: [{ userId: "u-1", fullName: "Мария Петрова", email: "p@mail.test", kind: "responsible" }]
      }
    ],
    total: 1
  });

  render(<ReplyMarker emailId="e-1" onMarked={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать поручение или создать резолюцию" }));
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать" }));
  fireEvent.change(await screen.findByPlaceholderText("Кому и что сделать"), {
    target: { value: "Петровой подготовить ответ" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Утвердить и отправить" }));

  await waitFor(() => expect(resolutionApi.approve).toHaveBeenCalledTimes(1));
  expect((resolutionApi.approve as jest.Mock).mock.calls[0][0]).toBe("res-2");
});

it("руководитель может создать резолюцию по документу, если поручения ещё нет", async () => {
  asUser("u-signer", ["journal.view", "resolution.approve"]);
  (resolutionApi.replyContext as jest.Mock).mockResolvedValue([]);
  (resolutionApi.forApproval as jest.Mock).mockResolvedValue({ items: [], total: 0 });
  (api.journal as jest.Mock).mockResolvedValue({
    items: [
      {
        id: "doc-1",
        regNumber: "вх1",
        summary: "Приглашение на участие в ВКС",
        resolution: null
      }
    ],
    total: 1
  });

  render(<ReplyMarker emailId="e-1" onMarked={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Выбрать поручение или создать резолюцию" }));
  expect(await screen.findByText("Документы без поручения")).not.toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Создать резолюцию" }));

  // Текст письма-запроса не должен становиться текстом резолюции.
  const field = (await screen.findByPlaceholderText("Кому и что сделать")) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(screen.getByRole("button", { name: "Создать и отправить" })).not.toBeNull();

  // Исполнителя можно найти по почте, а не только по ФИО.
  const combo = screen.getAllByRole("combobox")[0];
  fireEvent.mouseDown(combo);
  fireEvent.change(combo, { target: { value: "p@mail.test" } });
  expect(await screen.findByText("Мария Петрова")).not.toBeNull();
});

it("исполнитель сам регистрирует свой отчёт из письма", async () => {
  asUser("u-executor", ["journal.view", "task.report"]);
  (resolutionApi.replyContext as jest.Mock).mockResolvedValue([reportItem]);

  render(<ReplyMarker emailId="e-1" onMarked={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Это мой отчёт" }));
  fireEvent.change(await screen.findByPlaceholderText("Кратко: что сделано и с каким результатом"), {
    target: { value: "Ответ отправлен" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить отчёт" }));

  await waitFor(() =>
    expect(resolutionApi.report).toHaveBeenCalledWith("res-1", "Ответ отправлен", "e-1")
  );
});
