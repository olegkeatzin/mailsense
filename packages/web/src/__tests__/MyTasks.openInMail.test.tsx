/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { email: jest.fn() },
  resolutionApi: {
    myTasks: jest.fn(),
    markReceived: jest.fn().mockResolvedValue({}),
    sourceEmail: jest.fn(),
    icsUrl: () => ""
  },
  notificationApi: {},
  taskSourceAttachment: jest.fn(),
  saveBlob: jest.fn(),
  bytesToBase64: jest.fn(() => "AA==")
}));

import { api, resolutionApi } from "../api";
import { MyTasks } from "../components/MyTasks";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, TaskSourceEmail } from "../types";
import type { TaskItem } from "../resolutionTypes";

/**
 * Исполнитель с СОБСТВЕННОЙ почтой открывает настоящее письмо из своего ящика:
 * сервер отдаёт ownEmailId — копию письма о поручении.
 *
 * Отдельный файл: сценарий кликает «Открыть в почте» и меняет раздел приложения.
 * В общем наборе он ловил состояние предыдущего теста и падал по таймауту.
 */
const initial = useStore.getState();

const letter = {
  resolutionId: "res-1",
  emailId: "mail-1",
  subject: "Поручение по документу вх38",
  from: { address: "apparat@mail.test" },
  to: [],
  cc: [],
  date: "2026-10-20T10:00:00.000Z",
  bodyText: "текст",
  bodyHtml: null,
  attachments: [],
  ownEmailId: "mail-own-1"
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
  (api.email as jest.Mock).mockResolvedValue({ id: "mail-own-1" });
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

it("кнопка открывает письмо из своего ящика", async () => {
  render(<MyTasks />);
  fireEvent.click(await screen.findByRole("button", { name: "Письмо" }));
  const open = await screen.findByRole("button", { name: "Открыть в почте" });
  fireEvent.click(open);

  await waitFor(() => expect(api.email).toHaveBeenCalledWith("mail-own-1", expect.anything()));
  expect(useStore.getState().section).toBe("mail");
});
