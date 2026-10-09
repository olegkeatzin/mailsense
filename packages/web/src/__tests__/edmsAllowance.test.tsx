/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn(),
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
import type { Account, EdmsMailAllowance } from "../types";

/**
 * Таблица пользователей и модалка выдачи тяжёлые (antd Table + Select + загрузка списков):
 * в полном прогоне под нагрузкой они не укладывались в секунду ожидания и падали по ТАЙМАУТУ,
 * а не по проверке. Лимиты подняты, сами проверки те же.
 */
jest.setTimeout(120000);

const personal = { id: "acc-1", username: "petrova@mail.test", host: "mail.test", smtpReady: true, kind: "personal" as const };

const allowance: EdmsMailAllowance = {
  userId: "u-1",
  accountIds: ["acc-1"],
  allowed: [personal],
  resetChoice: null
};

describe("выдача ящиков для СЭД администратором (T57)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.accounts as jest.Mock).mockResolvedValue([
      { id: "acc-1", username: "petrova@mail.test" },
      { id: "acc-2", username: "secretary@mail.test" }
    ] as unknown as Account[]);
    (resolutionApi.userEdmsMailAllowance as jest.Mock).mockResolvedValue(allowance);
    (resolutionApi.saveUserEdmsMailAllowance as jest.Mock).mockImplementation((_userId: string, ids: string[]) =>
      Promise.resolve({ ...allowance, accountIds: ids })
    );
  });

  it("показывает выданные ящики и объясняет правило", async () => {
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);

    await waitFor(() => expect(resolutionApi.userEdmsMailAllowance).toHaveBeenCalledWith("u-1"));
    expect(await screen.findByText(/Работник сможет выбрать для писем СЭД только отмеченные здесь ящики/)).not.toBeNull();
    // Выданный ящик виден как выбранный, доступные — в списке.
    // Подпись выбранного ящика содержит host и признак — ищем по фрагменту.
    expect(await screen.findByText(/petrova@mail\.test/)).not.toBeNull();
  });

  it("сохранение отправляет список выданных ящиков", async () => {
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findByText(/petrova@mail\.test/);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Выданные ящики" }));
    fireEvent.click(await screen.findByText(/secretary@mail\.test/));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(resolutionApi.saveUserEdmsMailAllowance).toHaveBeenCalledWith("u-1", ["acc-1", "acc-2"])
    );
  });

  it("отозвали выбранный ящик — говорим администратору, что выбор работника сброшен", async () => {
    (resolutionApi.saveUserEdmsMailAllowance as jest.Mock).mockResolvedValue({
      ...allowance,
      accountIds: [],
      allowed: [],
      resetChoice: "acc-1"
    });
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findByText(/petrova@mail\.test/);

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect((document.body.textContent ?? "").match(/Выбор работника сброшен/)).not.toBeNull());
    expect((document.body.textContent ?? "").match(/petrova@mail.test/)).not.toBeNull();
  });

  it("пустой список — это отзыв всех ящиков, а не «ничего не делать»", async () => {
    (resolutionApi.userEdmsMailAllowance as jest.Mock).mockResolvedValue({ ...allowance, accountIds: [], allowed: [] });
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);
    await screen.findByRole("combobox", { name: "Выданные ящики" });

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(resolutionApi.saveUserEdmsMailAllowance).toHaveBeenCalledWith("u-1", []));
  });

  it("коды ошибок сервера объясняются словами, а не показываются как есть", () => {
    const withCode = (code: string) => {
      const err = new Error("400 Bad Request") as Error & { code?: string };
      err.code = code;
      return err;
    };
    expect(edmsAllowanceErrorText(withCode("unknown_account"))).toMatch(/Такого ящика нет/);
    expect(edmsAllowanceErrorText(withCode("bad_accounts"))).toMatch(/Список ящиков передан неверно/);
    expect(edmsAllowanceErrorText(withCode("user_not_found"))).toMatch(/Работник не найден/);
    expect(edmsAllowanceErrorText(new Error("403 Forbidden"))).toMatch(/Недостаточно прав/);
  });

  it("без права на почту список ящиков недоступен — говорим честно, выданные видны", async () => {
    (api.accounts as jest.Mock).mockRejectedValue(new Error("403 Forbidden"));
    render(<EdmsMailAllowanceModal user={{ id: "u-1", fullName: "Мария Петрова" }} onClose={() => {}} />);

    expect(await screen.findByText(/Полный список ящиков недоступен/)).not.toBeNull();
    expect(await screen.findByText(/petrova@mail.test/)).not.toBeNull();
  });

  it("в списке пользователей есть действие «Настроить», открывающее выдачу", async () => {
    (api.users as jest.Mock).mockResolvedValue([
      { id: "u-1", fullName: "Мария Петрова", email: "p@mail.test", roles: [], isActive: true, blocked: false }
    ]);
    (api.roles as jest.Mock).mockResolvedValue([]);

    render(<UsersTab />);
    // Явные ожидания: список пользователей и открытие модалки в jsdom не мгновенны.
    fireEvent.click(await screen.findByRole("button", { name: "Настроить" }, { timeout: 20000 }));

    expect(await screen.findByText("Ящики для СЭД: Мария Петрова", {}, { timeout: 20000 })).not.toBeNull();
    await waitFor(() => expect(resolutionApi.userEdmsMailAllowance).toHaveBeenCalledWith("u-1"));
  });
});
