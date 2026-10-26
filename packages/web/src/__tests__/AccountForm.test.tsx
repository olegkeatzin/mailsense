/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    mailDefaults: jest.fn(),
    saveMailDefaults: jest.fn(),
    accounts: jest.fn(),
    createAccount: jest.fn(),
    updateAccount: jest.fn(),
    deleteAccount: jest.fn(),
    testAccount: jest.fn(),
    testSmtp: jest.fn(),
    fetchAccount: jest.fn()
  },
  notificationApi: {}
}));

import { api } from "../api";
import { AccountTab } from "../components/SettingsModal";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

/**
 * «Добавить аккаунт»: работник вводит только логин и пароль.
 *
 * Сервер, порт и шифрование лежат в свёрнутой панели «Дополнительно» и приходят
 * из умолчаний предприятия. Без forceRender эти обязательные поля не монтировались,
 * и форма ругалась на пустые значения, пока панель не откроют руками.
 */
const initial = useStore.getState();

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (api.mailDefaults as jest.Mock).mockResolvedValue({
    imap: { host: "mail.test", port: 993, tls: "ssl", authType: "login" },
    smtp: { host: "mail.test", port: 465, tls: "ssl", authType: "login" }
  });
  (api.accounts as jest.Mock).mockResolvedValue([]);
  (api.createAccount as jest.Mock).mockResolvedValue({ id: "acc-new" });
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: [], roles: [] } as unknown as AuthUser,
    accounts: []
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
});

it("добавляет ящик по логину и паролю, не открывая «Дополнительно»", async () => {
  render(<AccountTab />);

  // Дожидаемся умолчаний предприятия: именно они подставляются в скрытые поля.
  await waitFor(() => expect(api.mailDefaults).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Добавить аккаунт" }));

  fireEvent.change(await screen.findByLabelText("Логин"), { target: { value: "post@mail.test" } });
  fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "secret" } });

  // Скрытые поля уже смонтированы и заполнены — проверяем до отправки.
  await waitFor(() => expect((screen.getByLabelText("Сервер") as HTMLInputElement).value).toBe("mail.test"));

  fireEvent.click(screen.getByRole("button", { name: /^Добавить$/ }));

  await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(1));
  const payload = (api.createAccount as jest.Mock).mock.calls[0][0] as { host: string; port: number };
  expect(payload.host).toBe("mail.test");
  expect(payload.port).toBe(993);
});
