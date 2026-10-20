/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn(),
    searchContacts: jest.fn(),
    users: jest.fn(),
    roles: jest.fn(),
    setUserRoles: jest.fn(),
    updateUser: jest.fn()
  },
  resolutionApi: {
    userEdmsMailAllowance: jest.fn(),
    saveUserEdmsMailAllowance: jest.fn()
  }
}));

import { api, resolutionApi } from "../api";
import { EdmsMailAllowanceModal } from "../components/EdmsMailAllowanceModal";
import { UsersTab } from "../components/DocflowAdmin";
import { edmsAllowanceErrorText } from "../components/edmsMail";
import type { EdmsMailAllowance } from "../types";

/**
 * Выдача «почты для СЭД» администратором (T57 → docs/design/mail-ownership.md).
 *
 * Администратор назначает АДРЕС (подсказки — из каталога), а пароль от ящика вводит сам
 * работник. Список ящиков сервера для выдачи больше не нужен: он не говорит, что работник
 * сможет подключить, а чужие ящики показывать администратору незачем.
 */
jest.setTimeout(120000);

const personal = { id: "acc-1", username: "petrova@mail.test", host: "mail.test", smtpReady: true, kind: "personal" as const };

const allowance: EdmsMailAllowance = {
  userId: "u-1",
  addresses: ["petrova@mail.test"],
  accountIds: ["acc-1"],
  allowed: [personal],
  resetChoice: null
};

describe("выдача ящиков для СЭД администратором (T57)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.searchContacts as jest.Mock).mockResolvedValue([
      { login: "ivanov", displayName: "Иванов Иван", mail: "ivanov@kniitmu.ru", dn: "CN=Иванов" }
    ]);
    (resolutionApi.userEdmsMailAllowance as jest.Mock).mockResolvedValue(allowance);
    (resolutionApi.saveUserEdmsMailAllowance as jest.Mock).mockImplementation(
      (_userId: string, addresses: string[]) => Promise.resolve({ ...allowance, addresses })
    );
  });

  it("показывает выданные адреса и объясняет правило", async () => {
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);

    await waitFor(() => expect(resolutionApi.userEdmsMailAllowance).toHaveBeenCalledWith("u-1"));
    expect(
      await screen.findByText(/Работник выбирает ящик для СЭД САМ/)
    ).not.toBeNull();
    expect((await screen.findAllByText(/petrova@mail\.test/)).length).toBeGreaterThan(0);
  });

  it("сохранение отправляет адреса, а не идентификаторы ящиков", async () => {
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findAllByText(/petrova@mail\.test/);

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(resolutionApi.saveUserEdmsMailAllowance).toHaveBeenCalledWith("u-1", ["petrova@mail.test"])
    );
  });

  it("подсказки адресов берутся из каталога", async () => {
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    const input = await screen.findByRole("combobox", { name: "Адреса ящиков для СЭД" });

    fireEvent.change(input, { target: { value: "иван" } });

    await waitFor(() => expect(api.searchContacts).toHaveBeenCalledWith("иван", 20), { timeout: 10000 });
  });

  it("отозвали выбранный ящик — говорим администратору, что выбор работника сброшен", async () => {
    (resolutionApi.saveUserEdmsMailAllowance as jest.Mock).mockResolvedValue({
      ...allowance,
      addresses: [],
      accountIds: [],
      allowed: [],
      resetChoice: "acc-1"
    });
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findAllByText(/petrova@mail\.test/);

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect((document.body.textContent ?? "").match(/Выбор работника сброшен/)).not.toBeNull());
    expect((document.body.textContent ?? "").match(/petrova@mail.test/)).not.toBeNull();
  });

  it("пустой список — это отзыв всех адресов, а не «ничего не делать»", async () => {
    (resolutionApi.userEdmsMailAllowance as jest.Mock).mockResolvedValue({
      ...allowance,
      addresses: [],
      accountIds: [],
      allowed: []
    });
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findByRole("combobox", { name: "Адреса ящиков для СЭД" });

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(resolutionApi.saveUserEdmsMailAllowance).toHaveBeenCalledWith("u-1", []));
  });

  it("коды ошибок сервера объясняются словами, а не показываются как есть", () => {
    const withCode = (code: string) => {
      const err = new Error("400 Bad Request") as Error & { code?: string };
      err.code = code;
      return err;
    };
    expect(edmsAllowanceErrorText(withCode("bad_addresses"))).toMatch(/Список адресов передан неверно/);
    expect(edmsAllowanceErrorText(withCode("bad_address"))).toMatch(/не похоже на адрес ящика/);
    expect(edmsAllowanceErrorText(withCode("user_not_found"))).toMatch(/Работник не найден/);
    expect(edmsAllowanceErrorText(new Error("403 Forbidden"))).toMatch(/Недостаточно прав/);
  });

  it("в списке пользователей есть действие «Настроить», открывающее выдачу", async () => {
    (api.users as jest.Mock).mockResolvedValue([
      { id: "u-1", fullName: "Мария Петрова", email: "p@mail.test", roles: [], isActive: true, blocked: false }
    ]);
    (api.roles as jest.Mock).mockResolvedValue([]);

    render(<UsersTab />);
    // Явные ожидания: список пользователей и открытие модалки в jsdom не мгновенны.
    fireEvent.click(await screen.findByRole("button", { name: "Настроить" }, { timeout: 20000 }));

    expect(await screen.findByText("Почта для СЭД: Мария Петрова", {}, { timeout: 20000 })).not.toBeNull();
    await waitFor(() => expect(resolutionApi.userEdmsMailAllowance).toHaveBeenCalledWith("u-1"));
  });
});
