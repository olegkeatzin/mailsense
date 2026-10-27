/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ api: {}, notificationApi: {} }));

import AccountSidebar from "../components/AccountSidebar";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

/**
 * Боковое меню: какой раздел документооборота видит роль.
 *
 * Заказчик снял у исполнителя право «Смотреть журнал» — и вместе с журналом пропали
 * «Мои задачи»: заголовок «Документооборот» и весь список разделов были обёрнуты
 * в проверку journal.view. Права на задачи никто не отнимал.
 *
 * Здесь проверяется ПРАВИЛО, а не отдельный пункт: каждый раздел виден по своему праву,
 * а группа «Документооборот» показывается, пока в ней есть хоть один доступный раздел.
 */
const initial = useStore.getState();

function asUser(permissions: string[]) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { id: "u-1", fullName: "Проверочный", roles: ["executor"], permissions } as unknown as AuthUser
  });
}

describe("разделы документооборота в боковом меню", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    useStore.setState({ ...initial });
  });

  it("исполнитель без журнала видит «Мои задачи», но не видит «Журнал»", () => {
    asUser(["task.view", "task.report", "notifications.view"]);

    render(<AccountSidebar />);

    expect(screen.getByText("Мои задачи")).not.toBeNull();
    expect(screen.queryByText("Журнал")).toBeNull();
    // Группа существует ради задач: заголовок не должен исчезать вместе с журналом.
    expect(screen.getByText("Документооборот")).not.toBeNull();
  });

  it("с правом на журнал видны и журнал, и свои задачи", () => {
    asUser(["journal.view", "task.view", "task.report"]);

    render(<AccountSidebar />);

    expect(screen.getByText("Журнал")).not.toBeNull();
    expect(screen.getByText("Мои задачи")).not.toBeNull();
  });

  it("очередь подписанта видна по resolution.approve без журнала", () => {
    asUser(["resolution.approve"]);

    render(<AccountSidebar />);

    expect(screen.getByText("На утверждении")).not.toBeNull();
    expect(screen.queryByText("Журнал")).toBeNull();
  });

  it("очередь регистрации видна по journal.register без журнала", () => {
    asUser(["journal.register"]);

    render(<AccountSidebar />);

    expect(screen.getByText("На регистрацию")).not.toBeNull();
    expect(screen.queryByText("Журнал")).toBeNull();
  });

  it("без прав документооборота группы нет, а папки почты остаются", () => {
    asUser([]);

    render(<AccountSidebar />);

    expect(screen.queryByText("Документооборот")).toBeNull();
    expect(screen.queryByText("Мои задачи")).toBeNull();
    expect(screen.getByText("Входящие")).not.toBeNull();
  });

  it("в левой панели нет дублирующей кнопки «Настройки»", () => {
    asUser(["journal.view"]);

    render(<AccountSidebar />);

    // Настройки остались только в шапке, справа от пользователя.
    expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull();
  });
});
