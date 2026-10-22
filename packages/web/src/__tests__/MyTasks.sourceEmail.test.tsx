/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { email: jest.fn() },
  resolutionApi: {
    myTasks: jest.fn(),
    markReceived: jest.fn(),
    sourceEmail: jest.fn(),
    icsUrl: () => ""
  },
  notificationApi: {},
  taskSourceAttachment: jest.fn(),
  saveBlob: jest.fn(),
  bytesToBase64: jest.fn(() => "AA==")
}));

import { resolutionApi, saveBlob, taskSourceAttachment } from "../api";
import { MyTasks } from "../components/MyTasks";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, TaskSourceEmail } from "../types";
import type { TaskItem } from "../resolutionTypes";

/**
 * Письмо-источник открывается ПОРУЧЕНИЕМ, а не почтовым разделом.
 *
 * Вынесено отдельным файлом: тест открывает модалку и проверяет вложения.
 * В общем файле с десятком других сценариев это оставляло портал и замедляло
 * следующий тест на секунды — изоляция здесь дешевле, чем «лечить» таймауты.
 */
const initial = useStore.getState();

const letter: TaskSourceEmail = {
  resolutionId: "res-1",
  emailId: "mail-1",
  subject: "Вопрос о поставке",
  from: { address: "client@outside.test", name: "Клиент" },
  to: [],
  cc: [],
  date: "2026-10-07T09:00:00.000Z",
  bodyText: "текст письма",
  bodyHtml: null,
  attachments: [{ id: "a-1", filename: "приказ.pdf", mimeType: "application/pdf", size: 1024 }]
} as unknown as TaskSourceEmail;

const task = {
  resolutionId: "res-1",
  documentId: "doc-1",
  documentNumber: "вх38",
  emailId: "mail-1",
  text: "Подготовить ответ",
  kind: "executor",
  priority: "normal",
  deadline: null,
  daysLeft: null,
  overdue: false,
  dueSoon: false,
  receivedAt: "2026-10-07T09:00:00.000Z",
  reportAt: null,
  reportText: null
} as unknown as TaskItem;

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (resolutionApi.sourceEmail as jest.Mock).mockResolvedValue(letter);
  (resolutionApi.myTasks as jest.Mock).mockResolvedValue([task]);
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: ["task.view"], roles: ["executor"], fullName: "Петрова М." } as unknown as AuthUser,
    accounts: [{ id: "acc-1", username: "executor@mail.test", settings: {} } as never]
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
});

it("«Письмо» открывает письмо-источник и его вложения, не трогая почтовый раздел", async () => {
  render(<MyTasks />);
  fireEvent.click(await screen.findByRole("button", { name: "Письмо" }));

  await waitFor(() => expect(resolutionApi.sourceEmail).toHaveBeenCalledWith("res-1"));
  expect(await screen.findByText("Вопрос о поставке")).not.toBeNull();
  expect(await screen.findByText("текст письма")).not.toBeNull();
  expect(await screen.findByText("приказ.pdf")).not.toBeNull();

  // Вложения: не просто имена — их можно открыть и скачать (маршрут по поручению).
  (taskSourceAttachment as jest.Mock).mockResolvedValue(new Blob(["данные"]));
  fireEvent.click(screen.getByRole("button", { name: /Скачать/ }));
  await waitFor(() => expect(taskSourceAttachment).toHaveBeenCalledWith("res-1", "a-1"));
  await waitFor(() => expect(saveBlob).toHaveBeenCalled());
});
