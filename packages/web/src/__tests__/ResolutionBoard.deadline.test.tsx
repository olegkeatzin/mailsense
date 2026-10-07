/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ api: {}, resolutionApi: { board: jest.fn() } }));

import { resolutionApi } from "../api";
import { ResolutionBoard } from "../components/ResolutionBoard";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const mockBoard = resolutionApi.board as unknown as jest.Mock;
const initial = useStore.getState();

const card = {
  id: "res-1",
  documentId: "doc-1",
  documentNumber: "вх38",
  text: "Подготовить ответ",
  status: "sent",
  priority: "normal",
  deadline: "2026-10-04",
  daysLeft: -2,
  overdue: true,
  dueSoon: false,
  assignees: [],
  history: [],
  preparedByName: "Иван Иванов"
};

describe("срок на канбане резолюций", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      // Канбан требует resolution.create (сервер проверяет то же право).
      authUser: { permissions: ["journal.view", "resolution.create"], roles: ["clerk"] } as unknown as AuthUser
    });
    mockBoard.mockResolvedValue([{ key: "overdue", title: "Просрочено", items: [card] }]);
  });

  it("карточка называет число дней просрочки (А11: числа с сервера)", async () => {
    render(<ResolutionBoard />);

    expect(await screen.findByText("04.10.2026 · просрочено на 2 дня")).not.toBeNull();
  });

  it("без срока — «без срока», а не пустое место", async () => {
    mockBoard.mockResolvedValue([
      { key: "work", title: "В работе", items: [{ ...card, deadline: null, daysLeft: null, overdue: false }] }
    ]);
    render(<ResolutionBoard />);

    expect(await screen.findByText("без срока")).not.toBeNull();
  });
});
