/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    audit: jest.fn(),
    accounts: jest.fn(),
    users: jest.fn(),
    journal: jest.fn(),
    roles: jest.fn(),
    auditExportUrl: () => ""
  },
  resolutionApi: { get: jest.fn() }
}));

import { api, resolutionApi } from "../api";
import AuditTab, { collectUnresolvedIds } from "../components/AuditTab";
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
    (api.roles as jest.Mock).mockResolvedValue([]);
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
  /**
   * D8: уже спрошенные идентификаторы не запрашиваются повторно.
   *
   * Раньше эффект зависел от своей же обновляемой коллекции и не помнил неудачи —
   * экран настроек устраивал шторм (~430 запросов/с), пока открыт. Проверяем двумя
   * способами: живьём (сколько запросов делает компонент) и чистой функцией, которая
   * решает, что спрашивать, — без таймеров и кликов, чтобы тест не «залипал».
   */
  it("фильтр объектов показывает формы множественного числа без «ы»", async () => {
    render(<AuditTab />);
    await waitFor(() => expect(api.audit).toHaveBeenCalled());

    const entitySelect = screen.getAllByRole("combobox")[1];
    fireEvent.mouseDown(entitySelect);

    expect(await screen.findByText("Поручения")).not.toBeNull();
    expect(screen.getByText("Уведомления")).not.toBeNull();
    expect(screen.getByText("Правила сортировки")).not.toBeNull();
    expect(screen.getByText("Пользователи")).not.toBeNull();
    expect(screen.queryByText("Поручениеы")).toBeNull();
  });

  it("D8: один запрос на уникальный id, повторный проход ничего не добавляет", async () => {
    // Самый злой случай: ни один идентификатор не разрешается.
    (resolutionApi.get as jest.Mock).mockRejectedValue(new Error("404 Not Found"));
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.users as jest.Mock).mockResolvedValue([]);
    (api.journal as jest.Mock).mockResolvedValue({ items: [], total: 0 });

    render(<AuditTab />);
    await waitFor(() => expect(resolutionApi.get).toHaveBeenCalledTimes(4), { timeout: 10000 });
    const asked = (resolutionApi.get as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(new Set(asked).size).toBe(4);

    const entries = [
      {
        id: "a-1",
        userId: USER_ID,
        userName: "Иванов И.И.",
        action: "docflow.service_account",
        entityType: "settings",
        entityId: "settings-1",
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
    ] as unknown as Parameters<typeof collectUnresolvedIds>[0];

    // Повторный проход по тем же записям: уже спрошенные не возвращаются — это и был шторм.
    expect(collectUnresolvedIds(entries, new Set(), new Set(asked), 40)).toEqual([]);
    // И функция вообще способна вернуть идентификаторы: иначе проверка выше была бы пустой.
    expect(collectUnresolvedIds(entries, new Set(), new Set(), 40).sort()).toEqual([...asked].sort());
  }, 20000);
});

/**
 * Живая жалоба: «Поле: «—» → «изменено (не удалось расшифровать)»» на смене ролей.
 * Причина — справочник ролей не загружался, и идентификаторы ролей оставались немами.
 */
describe("аудит: смена ролей показывает названия ролей", () => {
  beforeAll(installDomEnvironment);
  afterEach(cleanup);

  const ROLE_A = "11111111-1111-4111-8111-111111111111";
  const ROLE_B = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.clearAllMocks();
    (api.audit as jest.Mock).mockResolvedValue({
      entries: [
        {
          id: "a-roles",
          userId: USER_ID,
          userName: "Иванов И.И.",
          action: "user.roles",
          entityType: "user",
          entityId: USER_ID,
          oldValue: JSON.stringify({ roles: [ROLE_A] }),
          newValue: JSON.stringify({ roles: [ROLE_B] }),
          createdAt: "2026-10-19T10:00:00.000Z"
        }
      ],
      total: 1
    });
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.users as jest.Mock).mockResolvedValue([{ id: USER_ID, fullName: "Иванов И.И.", email: "i@mail.test" }]);
    (api.journal as jest.Mock).mockResolvedValue({ items: [], total: 0 });
    (api.roles as jest.Mock).mockResolvedValue([
      { id: ROLE_A, name: "Исполнитель" },
      { id: ROLE_B, name: "Руководитель" }
    ]);
    (resolutionApi.get as jest.Mock).mockRejectedValue(new Error("404"));
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["audit.view", "users.manage"], roles: ["admin"] } as unknown as AuthUser
    });
  });

  it("роли показаны названиями, а не «не удалось расшифровать»", async () => {
    render(<AuditTab />);
    expect(await screen.findByText(/Исполнитель/)).not.toBeNull();
    expect(screen.getByText(/Руководитель/)).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/не удалось расшифровать/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
