/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    roles: jest.fn(),
    permissionCatalog: jest.fn(),
    createRole: jest.fn(),
    updateRole: jest.fn(),
    deleteRole: jest.fn()
  }
}));

import { api } from "../api";
import { RolesEditor } from "../components/RolesEditor";
import type { PermissionInfo, Role } from "../types";

/**
 * Конструктор ролей (пункт 1 заказчика).
 *
 * Администратор заводит роли сам и расставляет права галочками. Проверяем то, что важно
 * на живом экране: права приходят из каталога и группируются, сохранение отправляет
 * отмеченные права, а «Администратора» править и удалять нельзя.
 */
jest.setTimeout(120000);

const CATALOG: PermissionInfo[] = [
  { id: "journal.view", title: "Смотреть журнал", group: "Журнал" },
  { id: "journal.register", title: "Регистрировать документы", group: "Журнал" },
  { id: "task.view", title: "Видеть поручения", group: "Поручения" }
];

const ROLES: Role[] = [
  { id: "admin", name: "Администратор", description: "Полный доступ", sortOrder: 10, isSystem: true, permissions: ["journal.view"] },
  { id: "secretary", name: "Секретарь", description: "Ведёт журнал", sortOrder: 20, isSystem: true, permissions: ["journal.view", "journal.register"] }
];

describe("конструктор ролей", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.roles as jest.Mock).mockResolvedValue(ROLES);
    (api.permissionCatalog as jest.Mock).mockResolvedValue(CATALOG);
    (api.updateRole as jest.Mock).mockResolvedValue(ROLES[1]);
    (api.createRole as jest.Mock).mockResolvedValue({ ...ROLES[1], id: "custom", name: "Своя роль" });
    (api.deleteRole as jest.Mock).mockResolvedValue({ ok: true });
  });

  it("показывает роли и их права человеческими названиями", async () => {
    render(<RolesEditor />);

    expect(await screen.findByText("Секретарь")).not.toBeNull();
    // Права — тегами, а не машинными id.
    expect((await screen.findAllByText("Смотреть журнал")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Регистрировать документы")).length).toBeGreaterThan(0);
  });

  it("«Администратора» править и удалять нельзя", async () => {
    render(<RolesEditor />);
    const adminRow = (await screen.findByText("Администратор")).closest("tr") as HTMLElement;

    expect(within(adminRow).queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(within(adminRow).queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(within(adminRow).getByText("Не изменяется")).not.toBeNull();
  });

  it("правка роли отправляет отмеченные права галочками", async () => {
    render(<RolesEditor />);
    const row = (await screen.findByText("Секретарь")).closest("tr") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "Изменить" }));
    // Галочка «Видеть поручения» не отмечена — отмечаем её.
    const checkbox = await screen.findByRole("checkbox", { name: "Видеть поручения" });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(api.updateRole).toHaveBeenCalledWith(
        "secretary",
        expect.objectContaining({ permissions: expect.arrayContaining(["journal.view", "journal.register", "task.view"]) })
      )
    );
  });

  it("создание роли: название и права уходят на сервер", async () => {
    render(<RolesEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "Добавить роль" }));

    fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "Делопроизводитель" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Смотреть журнал" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(api.createRole).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Делопроизводитель", permissions: ["journal.view"] })
      )
    );
  });

  it("удаление роли спрашивает подтверждение", async () => {
    render(<RolesEditor />);
    const row = (await screen.findByText("Секретарь")).closest("tr") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "Удалить" }));
    // Подтверждение — в диалоге, а не в строке таблицы: у них одинаковая подпись кнопки.
    const confirmBtn = await waitFor(() => {
      const btn = document.querySelector(".ant-modal-confirm-btns .ant-btn-dangerous") as HTMLElement | null;
      if (!btn) throw new Error("диалог подтверждения ещё не открылся");
      return btn;
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(api.deleteRole).toHaveBeenCalledWith("secretary"));
  });
});
