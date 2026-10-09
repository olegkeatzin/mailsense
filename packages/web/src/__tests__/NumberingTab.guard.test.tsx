/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

/**
 * Вкладка нумерации тяжёлая: antd-таблица, модалки закрытия/отмены года и список периодов.
 * В одиночном прогоне под нагрузкой (QA работал в браузере) тест «неверный год…» не уложился
 * в лимит jest и упал по ТАЙМАУТУ, а не по проверке. Лимит поднят, сами проверки те же.
 */
jest.setTimeout(120000);

jest.mock("../api", () => ({
  api: {
    numbering: jest.fn(),
    saveNumbering: jest.fn(),
    archivePeriod: jest.fn(),
    reopenPeriod: jest.fn(),
    journalArchiveUrl: jest.fn(() => "/api/journal/export?year=2026"),
    journalExportUrl: jest.fn(() => "/api/journal/export.xlsx?period=2026"),
    importJournalArchive: jest.fn()
  }
}));

import { api } from "../api";
import NumberingTab from "../components/NumberingTab";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, NumberingState } from "../types";

/**
 * Защита от случайного закрытия года глазами человека.
 *
 * Проверяем три уровня так, как их видит пользователь: подтверждение вводом года
 * (а не «ОК»), предупреждение об объёме ТЕКСТОМ СЕРВЕРА (клиент его не сочиняет)
 * и отказ, который показывает ответ сервера как есть — «год НЕ закрыт».
 */
const initial = useStore.getState();

const numberingState = (over: Partial<NumberingState> = {}): NumberingState =>
  ({
    rules: [{ stream: "incoming", prefix: "вх", reset: "year", template: null }],
    openPeriod: "2026",
    archivedPeriods: [],
    reopenablePeriods: [],
    blockedReason: null,
    ...over
  }) as unknown as NumberingState;

const user = (permissions: string[]): AuthUser =>
  ({
    id: "u-1",
    ldapUid: "test",
    email: "test@stand.test",
    fullName: "Тестовый Пользователь",
    roles: ["admin"],
    permissions
  }) as unknown as AuthUser;

/**
 * Документооборот включён — значит права проверяются по ролям (при выключенном
 * интерфейс ничего не ограничивает, и тест «аппарат не видит отмену» был бы ложным).
 */
const docflowOn = { docflowEnabled: true, ldapConfigured: true, adminConfigured: true, needsBootstrap: false, hasAdmin: true } as unknown as AuthStatus;

const asAdmin = () =>
  useStore.setState({
    ...initial,
    authStatus: docflowOn,
    authUser: user(["journal.view", "journal.archive", "journal.reopen", "settings.manage"]),
    docflowUnavailable: false
  });

const asSecretary = () =>
  useStore.setState({
    ...initial,
    authStatus: docflowOn,
    authUser: user(["journal.view", "journal.archive"]),
    docflowUnavailable: false
  });

/** Закрывает год вводом года: открыть форму, вписать год, нажать. */
async function confirmClose(year: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp("Выгрузить и закрыть " + year) }, { timeout: 8000 }));
  const input = await screen.findByPlaceholderText(year, {}, { timeout: 8000 });
  fireEvent.change(input, { target: { value: year } });
  fireEvent.click(screen.getByRole("button", { name: /^Закрыть год$/ }));
}

describe("закрытие года подтверждается вводом года", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    asAdmin();
    (api.numbering as jest.Mock).mockResolvedValue(numberingState());
    (api.archivePeriod as jest.Mock).mockResolvedValue({ ok: true, period: "2026", documentCount: 3 });
    (api.reopenPeriod as jest.Mock).mockResolvedValue({ ok: true, period: "2026" });
  });

  it("без введённого года запрос не уходит: «ОК» нажимают не глядя", async () => {
    render(<NumberingTab />);
    fireEvent.click(await screen.findByRole("button", { name: /Выгрузить и закрыть 2026/ }, { timeout: 8000 }));
    const ok = await screen.findByRole("button", { name: /^Закрыть год$/ }, { timeout: 8000 });

    // В этой обвязке нет jest-dom: проверяем само свойство кнопки.
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ok);
    expect(api.archivePeriod).not.toHaveBeenCalled();
  });

  it("неверный год не отправляется, верный — уходит с подтверждением", async () => {
    render(<NumberingTab />);

    fireEvent.click(await screen.findByRole("button", { name: /Выгрузить и закрыть 2026/ }, { timeout: 8000 }));
    const input = await screen.findByPlaceholderText("2026", {}, { timeout: 8000 });
    fireEvent.change(input, { target: { value: "2025" } });
    fireEvent.click(screen.getByRole("button", { name: /^Закрыть год$/ }));
    expect(api.archivePeriod).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026" } });
    fireEvent.click(screen.getByRole("button", { name: /^Закрыть год$/ }));

    await waitFor(() => expect(api.archivePeriod).toHaveBeenCalledWith("2026", "2026"));
  });

  it("отказ сервера показывается как есть: «год НЕ закрыт» и причина", async () => {
    (api.archivePeriod as jest.Mock).mockRejectedValue(
      new Error("Снимок года не сделан — год НЕ закрыт. Причина: нет места на диске. Данные журнала не изменялись.")
    );

    render(<NumberingTab />);
    await confirmClose("2026");

    expect(await screen.findByText(/год НЕ закрыт/)).toBeTruthy();
    expect(await screen.findByText(/нет места на диске/)).toBeTruthy();
  });
});

describe("отмена закрытия года", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    asAdmin();
    (api.numbering as jest.Mock).mockResolvedValue(
      numberingState({ archivedPeriods: ["2026"], reopenablePeriods: ["2026"] })
    );
    (api.reopenPeriod as jest.Mock).mockResolvedValue({ ok: true, period: "2026" });
    (api.archivePeriod as jest.Mock).mockResolvedValue({ ok: true, period: "2026", documentCount: 1 });
  });

  it("аппарат кнопки отмены не видит: отмена — изменение задним числом", async () => {
    asSecretary();

    render(<NumberingTab />);
    await screen.findByRole("button", { name: /Выгрузить и закрыть 2026/ }, { timeout: 8000 });

    expect(screen.queryByRole("button", { name: /Отменить закрытие/ })).toBeNull();
  });

  it("причина обязательна: без неё отмена не уходит", async () => {
    render(<NumberingTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Отменить закрытие…" }, { timeout: 8000 }));
    const input = await screen.findByPlaceholderText("2026", {}, { timeout: 8000 });
    fireEvent.change(input, { target: { value: "2026" } });
    const submit = screen.getByRole("button", { name: /^Отменить закрытие$/ });

    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(api.reopenPeriod).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Почему/), { target: { value: "закрыли по ошибке" } });
    fireEvent.click(submit);

    await waitFor(() => expect(api.reopenPeriod).toHaveBeenCalledWith("2026", "2026", "закрыли по ошибке"));
  });

  it("отказ сервера объясняет причину: «в 2027 уже зарегистрированы документы»", async () => {
    (api.reopenPeriod as jest.Mock).mockRejectedValue(
      new Error("В 2027 году уже зарегистрированы документы: номера выданы, отменить закрытие 2026 года нельзя.")
    );

    render(<NumberingTab />);
    fireEvent.click(await screen.findByRole("button", { name: /Отменить закрытие/ }, { timeout: 8000 }));
    fireEvent.change(await screen.findByPlaceholderText("2026", {}, { timeout: 8000 }), { target: { value: "2026" } });
    fireEvent.change(screen.getByPlaceholderText(/Почему/), { target: { value: "передумали" } });
    fireEvent.click(screen.getByRole("button", { name: /^Отменить закрытие$/ }));

    expect(await screen.findByText(/В 2027 году уже зарегистрированы документы/)).toBeTruthy();
  });

  it("если в новом году уже есть документы, сервер не отдаёт год в список — и это видно", async () => {
    (api.numbering as jest.Mock).mockResolvedValue(
      numberingState({ archivedPeriods: ["2026"], reopenablePeriods: [] })
    );

    render(<NumberingTab />);

    expect(await screen.findByText(/Отмена недоступна/)).toBeTruthy();
  });
});