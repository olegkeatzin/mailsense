/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { serviceAccount: jest.fn(), setServiceAccount: jest.fn() }
}));

import { api } from "../api";
import { ServiceAccountAdmin } from "../components/ServiceAccountAdmin";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, ServiceAccountState } from "../types";

const mockGet = api.serviceAccount as unknown as jest.Mock;
const mockPut = api.setServiceAccount as unknown as jest.Mock;
const initial = useStore.getState();

const account = (id: string, username: string) => ({
  accountId: id,
  name: username,
  username,
  protocol: "imap" as const,
  host: "mailserver",
  port: 993,
  tls: "ssl",
  authType: "login",
  smtpHost: "mailserver",
  smtpPort: 465,
  smtpTls: "ssl",
  smtpUsername: username,
  smtpHostConfigured: true,
  smtpConfigured: true
});

const state = (patch: Partial<ServiceAccountState> = {}): ServiceAccountState => ({
  configured: true,
  account: account("acc-1", "post"),
  problem: null,
  problemCode: "ok",
  incoming: {
    configured: true,
    account: account("acc-3", "intake"),
    problem: null,
    problemCode: "ok"
  },
  sameAccount: false,
  notice: null,
  ...patch
});

function asAdmin(permissions: string[] = ["settings.manage"]) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["admin"] } as unknown as AuthUser,
    accounts: [
      { id: "acc-1", username: "post" },
      { id: "acc-2", username: "post2" },
      { id: "acc-3", username: "intake" }
    ] as never
  });
}

/**
 * T25/T26: две служебные роли. Перепутать их нельзя: с внутренней уходит письмо
 * руководителю, внешняя — приёмная для почты контрагентов.
 */
describe("служебные ящики: две роли (T25)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({ ...initial, accounts: [] });
    mockGet.mockResolvedValue(state());
    mockPut.mockResolvedValue({
      ...state({ account: account("acc-2", "post2"), incoming: { configured: true, account: account("acc-3", "intake"), problem: null, problemCode: "ok" } }),
      ok: true
    });
  });

  it("без права settings.manage раздела нет и запроса нет", async () => {
    asAdmin(["journal.register"]);
    render(<ServiceAccountAdmin />);

    expect(screen.queryByText("Служебные ящики")).toBeNull();
    await Promise.resolve();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("показываются два селектора: внутренняя и внешняя приёмная", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);

    expect(await screen.findByText("Служебные ящики")).not.toBeNull();
    expect(screen.getByText("Внутренняя (делопроизводство)")).not.toBeNull();
    expect(screen.getByText("Внешняя (приёмная)")).not.toBeNull();
    // Ищем внутри своей группы: «post» есть в обеих ролях, и без группы выбор неоднозначен.
    const innerGroup = screen.getByRole("group", { name: "Внутренняя (делопроизводство)" });
    const incomingGroup = screen.getByRole("group", { name: "Внешняя (приёмная)" });
    expect(within(innerGroup).getByRole("radio", { name: "post" })).toHaveProperty("checked", true);
    expect(within(incomingGroup).getByRole("radio", { name: "intake" })).toHaveProperty("checked", true);
  });

  it("сохранение отправляет ОБА идентификатора одним вызовом и берёт ответ без второго GET", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);
    await screen.findByText("Служебные ящики");
    const getCalls = mockGet.mock.calls.length;

    fireEvent.click(
      within(screen.getByRole("group", { name: "Внутренняя (делопроизводство)" })).getByRole("radio", { name: "post2" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({ accountId: "acc-2", incomingAccountId: "acc-3" })
    );
    // Ответ PUT — тот же shape, что GET: перечитывать не нужно.
    expect(mockGet.mock.calls.length).toBe(getCalls);
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Внутренняя (делопроизводство)" })).getByRole("radio", { name: "post2" })
      ).toHaveProperty("checked", true)
    );
  });

  it("снять выбор можно у каждой роли отдельно", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);
    await screen.findByText("Служебные ящики");

    fireEvent.click(
      within(screen.getByRole("group", { name: "Внешняя (приёмная)" })).getByRole("radio", { name: "Не выбран" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({ accountId: "acc-1", incomingAccountId: null })
    );
  });

  it("один ящик на две роли — предупреждение сервера текстом, но сохранять можно", async () => {
    asAdmin();
    mockGet.mockResolvedValue(
      state({
        sameAccount: true,
        notice: "Один ящик выбран и для делопроизводства, и для приёмной — это допустимо, но роли смешаны.",
        incoming: { configured: true, account: account("acc-1", "post"), problem: null, problemCode: "ok" }
      })
    );
    render(<ServiceAccountAdmin />);

    expect(
      await screen.findByText("Один ящик выбран и для делопроизводства, и для приёмной — это допустимо, но роли смешаны.")
    ).not.toBeNull();
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("право отозвали — понятный текст, без повторов", async () => {
    asAdmin();
    mockGet.mockRejectedValue(new Error("403 Forbidden"));
    render(<ServiceAccountAdmin />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
