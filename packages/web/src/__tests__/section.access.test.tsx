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
    forConfirmation: jest.fn(),
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

/** Администратор: у него есть всё, включая подтверждение разбора. */
const admin = {
  id: "u-admin",
  email: "admin@stand.test",
  fullName: "Администратор",
  permissions: ["journal.view", "resolution.create", "resolution.approve", "resolution.dispatch", "task.view"],
  roles: ["admin"]
} as unknown as AuthUser;

/** Исполнитель Петрова: ни подтверждения разбора, ни поручения — обычный сотрудник. */
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
    (resolutionApi.forConfirmation as jest.Mock).mockResolvedValue({ items: [], total: 0 });
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([]);
  });

  /**
   * Сценарий QA: администратор стоял на «На подтверждении», вышел, вошёл исполнитель.
   * Раздел аппарата восстанавливался исполнителю, и приложение в фоне просило
   * for-confirmation и executor-candidates — 403 в консоли у роли без прав.
   */
  it("админ стоял на confirmation → вошёл исполнитель: раздел сброшен, чужих запросов нет", async () => {
    asUser(admin, "confirmation");
    (api.login as jest.Mock).mockResolvedValue({ user: executor, expiresAt: "" });

    await useStore.getState().login("petrova_ma", "secret");

    expect(useStore.getState().authUser?.email).toBe("petrova_ma@stand.test");
    expect(useStore.getState().section).not.toBe("confirmation");
    // Первый доступный по правам: у исполнителя есть journal.view.
    expect(useStore.getState().section).toBe("journal");

    // Раздел «На подтверждении» у исполнителя не грузит данные вообще.
    render(<ApprovalList mode="confirm" />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(resolutionApi.forConfirmation).not.toHaveBeenCalled();
    expect(resolutionApi.executorCandidates).not.toHaveBeenCalled();
  });

  it("выход сбрасывает раздел: следующий пользователь не наследует чужой выбор", async () => {
    asUser(admin, "confirmation");

    await useStore.getState().logout();

    expect(useStore.getState().section).toBe("mail");
  });

  it("раздел, на который нет прав, не открывается и программно", () => {
    asUser(executor, "mail");

    useStore.getState().setSection("confirmation");

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
    [["resolution.dispatch"], "confirmation"],
    [[], "mail"]
  ])("права %j → первый доступный раздел %s", (permissions, expected) => {
    const can = (p: string) => (permissions as string[]).includes(p);
    expect(resolveSection("confirmation", can as never)).toBe(expected);
  });

  it("доступный запрошенный раздел остаётся прежним", () => {
    const can = (p: string) => p === "task.view";
    expect(resolveSection("tasks", can as never)).toBe("tasks");
  });
});
