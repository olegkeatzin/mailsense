/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn(),
    emails: jest.fn(),
    aiConfig: jest.fn(),
    login: jest.fn(),
    logout: jest.fn()
  },
  resolutionApi: {
    forApproval: jest.fn(),
    executorCandidates: jest.fn(),
    myTasks: jest.fn(),
    board: jest.fn()
  }
}));

import { api, resolutionApi } from "../api";
import { ApprovalList } from "../components/ApprovalList";
import { resolveSection, useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const initial = useStore.getState();

/** Администратор: у него есть всё. */
const admin = {
  id: "u-admin",
  email: "admin@stand.test",
  fullName: "Администратор",
  permissions: ["journal.view", "resolution.create", "resolution.approve", "resolution.dispatch", "task.view"],
  roles: ["admin"]
} as unknown as AuthUser;

/** Исполнитель Петрова: обычный сотрудник без управленческих разделов. */
const executor = {
  id: "u-petrova",
  email: "petrova_ma@stand.test",
  fullName: "Петрова М.А.",
  permissions: ["journal.view", "task.view", "task.report", "notifications.view"],
  roles: ["executor"]
} as unknown as AuthUser;

function asUser(user: AuthUser, section: typeof initial.section) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: user,
    section
  });
}

describe("раздел не переживает смену пользователя", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({ ...initial });
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.logout as jest.Mock).mockResolvedValue({ ok: true });
    (resolutionApi.forApproval as jest.Mock).mockResolvedValue({ items: [], total: 0 });
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([]);
  });

  /**
   * Сценарий QA: администратор стоял на «На утверждении», вышел, вошёл исполнитель.
   * Раздел не должен восстанавливаться исполнителю и тянуть чужие запросы.
   */
  it("админ стоял на approvals → вошёл исполнитель: раздел сброшен, чужих запросов нет", async () => {
    asUser(admin, "approvals");
    (api.login as jest.Mock).mockResolvedValue({ user: executor, expiresAt: "" });

    await useStore.getState().login("petrova_ma", "secret");

    expect(useStore.getState().authUser?.email).toBe("petrova_ma@stand.test");
    expect(useStore.getState().section).not.toBe("approvals");
    // Первый доступный по правам: у исполнителя есть journal.view.
    expect(useStore.getState().section).toBe("journal");

    render(<ApprovalList />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(resolutionApi.forApproval).not.toHaveBeenCalled();
    expect(resolutionApi.executorCandidates).not.toHaveBeenCalled();
  });

  it("выход сбрасывает раздел: следующий пользователь не наследует чужой выбор", async () => {
    asUser(admin, "approvals");

    await useStore.getState().logout();

    expect(useStore.getState().section).toBe("mail");
  });

  it("раздел, на который нет прав, не открывается и программно", () => {
    asUser(executor, "mail");

    useStore.getState().setSection("approvals");

    expect(useStore.getState().section).toBe("mail");
  });

  it("свой раздел исполнителя открывается по-прежнему", () => {
    asUser(executor, "mail");

    useStore.getState().setSection("tasks");

    expect(useStore.getState().section).toBe("tasks");
  });
});

describe("выбор доступного раздела по правам", () => {
  it.each([
    [["journal.view"], "journal"],
    [["journal.register", "journal.view"], "journal"],
    [["task.view"], "tasks"],
    [["resolution.create"], "board"],
    [["resolution.approve"], "approvals"],
    [["resolution.dispatch"], "mail"],
    [[], "mail"]
  ])("права %j → первый доступный раздел %s", (permissions, expected) => {
    const can = (p: string) => (permissions as string[]).includes(p);
    expect(resolveSection("approvals", can as never)).toBe(expected);
  });

  it("доступный запрошенный раздел остаётся прежним", () => {
    const can = (p: string) => p === "task.view";
    expect(resolveSection("tasks", can as never)).toBe("tasks");
  });
});
