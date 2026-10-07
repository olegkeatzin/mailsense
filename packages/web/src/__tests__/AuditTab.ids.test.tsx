/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    audit: jest.fn(),
    accounts: jest.fn(),
    users: jest.fn(),
    journal: jest.fn(),
    auditExportUrl: () => ""
  },
  resolutionApi: { get: jest.fn() }
}));

import { api, resolutionApi } from "../api";
import AuditTab from "../components/AuditTab";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const ACCOUNT_ID = "6f7367f6-0fa6-4e93-b5ef-d359e59c5de6";
const USER_ID = "258f7816-2af6-4a34-bfac-38a1227ee13f";
const DOC_ID = "9b1d3c44-5555-4666-8777-888899990000";
const RES_ID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

const initial = useStore.getState();

/**
 * D6: в «Что изменилось» не должно быть сырых идентификаторов.
 * Значения разрешаем: ящик → адрес, сотрудник → ФИО, документ → номер, поручение → номер поручения.
 */
describe("аудит: значения-идентификаторы разрешаются в человеческое", () => {
  beforeAll(installDomEnvironment);
  // Без размонтирования компоненты прошлых тестов остаются в DOM и жгут ожидания (тест «залипает»).
  afterEach(cleanup);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.audit as jest.Mock).mockResolvedValue({
      entries: [
        {
          id: "a-1",
          userId: USER_ID,
          userName: "Иванов И.И.",
          action: "docflow.service_account",
          entityType: "settings",
          entityId: "settings-1",
          // Показываем «что изменилось», поэтому оба значения должны быть изменениями:
          // иначе неизменённое поле в diff не попадает и проверять нечего.
          oldValue: JSON.stringify({ accountId: ACCOUNT_ID, userId: null }),
          newValue: JSON.stringify({ accountId: null, userId: USER_ID }),
          createdAt: "2026-10-07T09:00:00.000Z"
        },
        {
          id: "a-2",
          userId: USER_ID,
          userName: "Иванов И.И.",
          action: "journal.link_email",
          entityType: "document",
          entityId: DOC_ID,
          oldValue: JSON.stringify({ documentId: DOC_ID, resolutionId: null }),
          newValue: JSON.stringify({ documentId: null, resolutionId: RES_ID }),
          createdAt: "2026-10-07T09:05:00.000Z"
        }
      ],
      total: 2
    });
    (api.accounts as jest.Mock).mockResolvedValue([{ id: ACCOUNT_ID, username: "post@mail.test" }]);
    (api.users as jest.Mock).mockResolvedValue([{ id: USER_ID, fullName: "Мария Петрова", email: "p@mail.test" }]);
    (api.journal as jest.Mock).mockResolvedValue({ items: [{ id: DOC_ID, regNumber: "вх38" }], total: 1 });
    (resolutionApi.get as jest.Mock).mockResolvedValue({ documentNumber: "вх38" });
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["audit.view", "users.manage", "journal.view"], roles: ["admin"] } as unknown as AuthUser
    });
  });

  it("в тексте нет ни одного UUID, а значения показаны по-человечески", async () => {
    render(<AuditTab />);

    expect(await screen.findByText(/post@mail\.test/)).not.toBeNull();
    expect(screen.getAllByText(/Мария Петрова/).length).toBeGreaterThan(0);
    expect(await screen.findByText(/вх38/)).not.toBeNull();
    expect(screen.getAllByText(/поручение по вх38/).length).toBeGreaterThan(0);

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("неразрешённый идентификатор даёт нейтральный текст, а не UUID", async () => {
    (resolutionApi.get as jest.Mock).mockRejectedValue(new Error("403 Forbidden"));
    (api.users as jest.Mock).mockResolvedValue([]);
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.journal as jest.Mock).mockResolvedValue({ items: [], total: 0 });

    render(<AuditTab />);

    await waitFor(() =>
      expect(screen.getAllByText(/изменено \(не удалось расшифровать\)/).length).toBeGreaterThan(0)
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  /**
   * D8: неудачные идентификаторы НЕ должны запрашиваться повторно.
   * На прежнем коде эффект зависел от своей же обновляемой коллекции и не помнил неудачи —
   * экран настроек устраивал шторм тысяч запросов, пока открыт.
   */
  it("повторные проходы не повторяют запросы: один запрос на уникальный id (D8)", async () => {
    // Самый злой случай: ни один идентификатор не разрешается.
    (resolutionApi.get as jest.Mock).mockRejectedValue(new Error("404 Not Found"));
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.users as jest.Mock).mockResolvedValue([]);
    (api.journal as jest.Mock).mockResolvedValue({ items: [], total: 0 });

    render(<AuditTab />);
    // В фикстуре четыре уникальных идентификатора — столько запросов и должно быть.
    await waitFor(() => expect(resolutionApi.get).toHaveBeenCalledTimes(4));
    const after = (resolutionApi.get as jest.Mock).mock.calls.length;

    // Перезагрузка списка: эффект проходит заново — новых запросов быть не должно.
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((resolutionApi.get as jest.Mock).mock.calls.length).toBe(after);

    // И ещё раз: повторный проход тоже ничего не добавляет.
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((resolutionApi.get as jest.Mock).mock.calls.length).toBe(after);

    // Ни один id не спрошен дважды.
    const perId = new Map<string, number>();
    for (const call of (resolutionApi.get as jest.Mock).mock.calls) {
      const key = String(call[0]);
      perId.set(key, (perId.get(key) ?? 0) + 1);
    }
    expect([...perId.values()]).toEqual([1, 1, 1, 1]);
    // Явный лимит: зависший тест должен падать, а не висеть минутами.
  }, 30000);
});
