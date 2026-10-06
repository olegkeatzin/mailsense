/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ resolutionApi: { board: jest.fn() } }));

import { resolutionApi } from "../api";
import { ResolutionBoard } from "../components/ResolutionBoard";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const initial = useStore.getState();

const card = {
  id: "res-1",
  documentId: "doc-1",
  documentNumber: "вх38",
  text: "Подготовить ответ внешнему партнёру.",
  status: "pending_approval",
  priority: "normal",
  deadline: null,
  assignees: [],
  history: [],
  preparedByName: "Иван Иванов"
};

/**
 * Канбан без перехода — витрина: видно, что работа есть, а сделать ничего нельзя.
 * Карточка обязана вести к документу (там живут действия), но только тем, кому
 * журнал доступен по правам.
 */
describe("канбан резолюций", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (resolutionApi.board as jest.Mock).mockResolvedValue([
      { key: "pending", title: "На утверждении", items: [card] }
    ]);
    useStore.setState({
      ...initial,
      section: "board",
      documentIntent: null,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "resolution.approve"], roles: ["signer"] } as unknown as AuthUser
    });
  });

  it("карточка открывает документ в журнале", async () => {
    render(<ResolutionBoard />);

    fireEvent.click(await screen.findByRole("button", { name: /Открыть документ вх38/ }));

    expect(useStore.getState().documentIntent).toBe("doc-1");
    expect(useStore.getState().section).toBe("journal");
  });

  it("без права на журнал карточка не притворяется кликабельной", async () => {
    useStore.setState({
      authUser: { permissions: ["task.view"], roles: ["executor"] } as unknown as AuthUser
    });
    render(<ResolutionBoard />);

    await screen.findByText("вх38");
    expect(screen.queryByRole("button", { name: /Открыть документ/ })).toBeNull();
  });
});
