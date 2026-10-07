/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const account = {
  accountId: "acc-1",
  name: "post@mail.test",
  username: "post@mail.test",
  protocol: "imap",
  host: "mail.test",
  port: 993,
  tls: "ssl",
  authType: "login",
  smtpHost: "mail.test",
  smtpPort: 465,
  smtpTls: "ssl",
  smtpUsername: "post@mail.test",
  smtpHostConfigured: true,
  smtpConfigured: true
};

const state = (patch: Partial<ServiceAccountState> = {}): ServiceAccountState => ({
  configured: true,
  account,
  problem: null,
  problemCode: "ok",
  ...patch
});

function asAdmin(permissions: string[] = ["settings.manage", "journal.view"]) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["admin"] } as unknown as AuthUser,
    accounts: [
      { id: "acc-1", username: "post@mail.test" },
      { id: "acc-2", username: "post2@mail.test" }
    ] as never
  });
}

describe("выбор служебного ящика администратором (settings.manage)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({ ...initial, accounts: [] });
    mockGet.mockResolvedValue(state());
    mockPut.mockResolvedValue({ ...state({ account: { ...account, accountId: "acc-2", username: "post2@mail.test" } }), ok: true, accountId: "acc-2" });
  });

  it("без права settings.manage раздела нет и запроса нет", async () => {
    asAdmin(["journal.register"]);
    render(<ServiceAccountAdmin />);

    expect(screen.queryByText("Служебный ящик отправки")).toBeNull();
    await Promise.resolve();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("показывает текущий выбор и объясняет, на что он влияет", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);

    expect(await screen.findByText("Служебный ящик отправки")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "post@mail.test" })).toHaveProperty("checked", true);
    expect(screen.getByText(/с какого ящика уходят поручения/)).not.toBeNull();
  });

  it("сохранение уходит на сервер и берёт ответ, не перечитывая GET", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);
    await screen.findByText("Служебный ящик отправки");
    const before = mockGet.mock.calls.length;

    fireEvent.click(screen.getByRole("radio", { name: "post2@mail.test" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("acc-2"));
    // PUT возвращает тот же shape, что GET — второй запрос не нужен.
    expect(mockGet.mock.calls.length).toBe(before);
    await waitFor(() => expect(screen.getByRole("radio", { name: "post2@mail.test" })).toHaveProperty("checked", true));
  });

  it("снять выбор можно: на сервер уходит null", async () => {
    asAdmin();
    render(<ServiceAccountAdmin />);
    await screen.findByText("Служебный ящик отправки");

    fireEvent.click(screen.getByRole("radio", { name: /Не выбран/ }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith(null));
  });

  it("нет права — честное сообщение, без повторов", async () => {
    asAdmin();
    mockGet.mockRejectedValue(new Error("403 Forbidden"));
    render(<ServiceAccountAdmin />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
