/** @jest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {},
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

import { resolutionApi } from "../api";
import { MyTasks } from "../components/MyTasks";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";
import type { TaskItem } from "../resolutionTypes";

/**
 * «Видеть поручения» и «Отчитываться» — РАЗНЫЕ права. Конструктор ролей позволяет
 * выдать первое без второго. Кнопка отчёта не должна вести на маршрут task.report,
 * который ответит 403.
 */
const initial = useStore.getState();

const task = {
  resolutionId: "res-1",
  documentId: "doc-1",
  documentNumber: "вх38",
  emailId: null,
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

function asUser(permissions: string[]) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["executor"], fullName: "Мария Петрова" } as unknown as AuthUser
  });
}

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (resolutionApi.myTasks as jest.Mock).mockResolvedValue([task]);
});

afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
});

it("без task.report кнопки отчёта нет, но задача видна", async () => {
  asUser(["task.view"]);
  render(<MyTasks />);

  expect(await screen.findByText("Подготовить ответ")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Отчитаться" })).toBeNull();
  expect(screen.getByText("нет права")).not.toBeNull();
});

it("с task.report кнопка отчёта на месте", async () => {
  asUser(["task.view", "task.report"]);
  render(<MyTasks />);

  expect(await screen.findByRole("button", { name: "Отчитаться" })).not.toBeNull();
});
