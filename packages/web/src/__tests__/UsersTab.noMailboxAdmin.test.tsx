/** @jest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    users: jest.fn(),
    roles: jest.fn(),
    setUserRoles: jest.fn(),
    updateUser: jest.fn(),
    syncUsers: jest.fn(),
    createUser: jest.fn()
  },
  notificationApi: {}
}));

import { api } from "../api";
import { UsersTab } from "../components/DocflowAdmin";

/**
 * Администратор больше не раздаёт работникам ящики для СЭД.
 *
 * Работник подключает свой ящик сам (он закреплён за ним в LDAP), а в списке
 * пользователей не должно остаться колонки «Почта для СЭД» с кнопкой «Настроить».
 */
beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (api.users as jest.Mock).mockResolvedValue([
    {
      id: "u-1",
      fullName: "Мария Петрова",
      email: "petrova@mail.test",
      roles: [],
      isActive: true,
      blocked: false,
      source: "ldap",
      lastLoginAt: null
    }
  ]);
  (api.roles as jest.Mock).mockResolvedValue([]);
});

afterEach(cleanup);

it("в списке пользователей нет выдачи почты для СЭД", async () => {
  render(<UsersTab />);

  expect(await screen.findByText("Мария Петрова")).not.toBeNull();
  expect(screen.queryByText("Почта для СЭД")).toBeNull();
  expect(screen.queryByRole("button", { name: "Настроить" })).toBeNull();
  // ФИО закреплено слева: при горизонтальной прокрутке видно, чьи это столбцы.
  expect(document.querySelector(".ant-table-cell-fix-left")).not.toBeNull();
});
