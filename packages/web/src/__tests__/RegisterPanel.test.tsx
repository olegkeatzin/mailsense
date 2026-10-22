/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    documentByEmail: jest.fn(),
    journalSuggest: jest.fn(),
    journalDuplicates: jest.fn(),
    nextRegNumber: jest.fn(),
    cases: jest.fn(),
    registerDocument: jest.fn()
  }
}));

import { api } from "../api";
import { RegisterPanel } from "../components/RegisterPanel";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const mockDocumentByEmail = api.documentByEmail as unknown as jest.Mock;

const initial = useStore.getState();

/**
 * Форма регистрации занимает пол-экрана, поэтому она обязана открываться по кнопке.
 * Тест падает, если форму сделают открытой всегда (тогда «Свернуть» видно сразу).
 */
describe("RegisterPanel: форма открывается по кнопке, а не всегда", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true, ldapConfigured: true, adminConfigured: true, needsBootstrap: false, hasAdmin: true } as unknown as AuthStatus,
      authUser: {
        id: "u-1",
        ldapUid: "Иванов_ИИ",
        email: "ivanov_ii@mail.test",
        fullName: "Иван Иванов",
        roles: ["secretary"],
        permissions: ["journal.register"]
      } as unknown as AuthUser,
      registerIntent: null
    });
    // Письмо ещё не в журнале — регистрировать можно.
    mockDocumentByEmail.mockResolvedValue(null);
    (api.journalSuggest as jest.Mock).mockResolvedValue({
      docNumber: "123",
      docDate: null,
      sender: "Партнёр",
      summary: "О поставке",
      sheetsCount: 1,
      documentName: ""
    });
    (api.journalDuplicates as jest.Mock).mockResolvedValue([]);
    (api.cases as jest.Mock).mockResolvedValue([]);
    (api.nextRegNumber as jest.Mock).mockResolvedValue({ regNumber: "вх1", period: "2026" });
  });

  it("пока форму не позвали — видна только кнопка", async () => {
    render(<RegisterPanel emailId="mail-1" />);

    const button = await screen.findByRole("button", { name: /Зарегистрировать/ });
    expect(button).toBeTruthy();
    // Формы нет: ни заголовка карточки, ни кнопки «Свернуть».
    expect(screen.queryByText("Регистрация входящего документа")).toBeNull();
    expect(screen.queryByRole("button", { name: "Свернуть" })).toBeNull();
  });

  /**
   * У исполнителя после снятия journal.view нет и journal.register. Раньше панель всё равно
   * запрашивала статус документа при каждом открытии письма — маршрут отвечал 403.
   */
  it("без права на журнал и регистрацию статус документа не запрашивается", async () => {
    useStore.setState({
      authUser: { ...useStore.getState().authUser!, permissions: ["task.view"] } as unknown as AuthUser
    });

    render(<RegisterPanel emailId="mail-1" />);

    expect(mockDocumentByEmail).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Зарегистрировать/ })).toBeNull();
  });

  it("с правом регистрации, но без журнала кнопка есть, а лишнего запроса нет", async () => {
    render(<RegisterPanel emailId="mail-1" />);

    expect(await screen.findByRole("button", { name: /Зарегистрировать/ })).not.toBeNull();
    expect(mockDocumentByEmail).not.toHaveBeenCalled();
  });

  it("по кнопке форма открывается, по «Свернуть» — снова прячется", async () => {
    render(<RegisterPanel emailId="mail-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Зарегистрировать/ }));

    await waitFor(() => expect(screen.getByText("Регистрация входящего документа")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Свернуть" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Свернуть" }));

    await waitFor(() => expect(screen.queryByText("Регистрация входящего документа")).toBeNull());
    expect(screen.getByRole("button", { name: /Зарегистрировать/ })).toBeTruthy();
  });
});
