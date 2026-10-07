/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { serviceAccount: jest.fn(), setServiceAccount: jest.fn() }
}));

import { api } from "../api";
import { ServiceAccountHint } from "../components/ServiceAccountHint";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, ServiceAccountState } from "../types";

const mockGet = api.serviceAccount as unknown as jest.Mock;
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

/** Аппарат: у него journal.register — право видеть подсказку. */
function asClerk(extra: string[] = []) {
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: ["journal.view", "journal.register", ...extra], roles: ["clerk"] } as unknown as AuthUser,
    accounts: []
  });
}

describe("подсказка аппарату про служебный ящик (Р12)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({ ...initial, accounts: [] });
    mockGet.mockResolvedValue(state());
  });

  it("без права journal.register подсказки нет и запроса нет", async () => {
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "task.view"], roles: ["executor"] } as unknown as AuthUser
    });

    render(<ServiceAccountHint />);

    expect(screen.queryByText("Служебный ящик")).toBeNull();
    await Promise.resolve();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("показывает параметры для подключения: хост, порт, TLS и логин", async () => {
    asClerk();
    render(<ServiceAccountHint />);

    expect(await screen.findByText("Служебный ящик")).not.toBeNull();
    expect(screen.getByText("mail.test:993")).not.toBeNull();
    expect(screen.getByText("ssl")).not.toBeNull();
    expect(screen.getByText("post@mail.test")).not.toBeNull();
  });

  it("ящика нет в клиенте — честный текст и кнопка «Скопировать параметры»", async () => {
    asClerk();
    render(<ServiceAccountHint />);

    expect(await screen.findByText("Попросите администратора подключить ящик post@mail.test")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Скопировать параметры" })).not.toBeNull();
  });

  it("ящик уже есть в списке клиента (сравнение по username) — «Ящик подключён»", async () => {
    asClerk();
    useStore.setState({
      accounts: [{ id: "local-1", username: "post@mail.test" }] as never
    });
    render(<ServiceAccountHint />);

    expect(await screen.findByText("Ящик подключён")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Скопировать параметры" })).toBeNull();
  });

  it("копmирование отдаёт параметры, а не текст интерфейса", async () => {
    asClerk();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ServiceAccountHint />);

    (await screen.findByRole("button", { name: "Скопировать параметры" })).click();

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0][0])).toContain("mail.test");
    expect(String(writeText.mock.calls[0][0])).toContain("post@mail.test");
  });

  it("отправка не настроена — сказано прямо, а не «всё хорошо»", async () => {
    asClerk();
    mockGet.mockResolvedValue(state({ account: { ...account, smtpHostConfigured: false, smtpConfigured: false } }));
    render(<ServiceAccountHint />);

    expect(await screen.findByText(/Отправка не настроена/)).not.toBeNull();
  });

  it("адрес SMTP есть, а пароля нет — сказано точнее, чем «не настроена»", async () => {
    asClerk();
    mockGet.mockResolvedValue(state({ account: { ...account, smtpConfigured: false } }));
    render(<ServiceAccountHint />);

    expect(await screen.findByText(/пароль не задан/)).not.toBeNull();
  });

  it("problemCode ok — никаких предупреждений о проблемах", async () => {
    asClerk();
    render(<ServiceAccountHint />);

    expect(await screen.findByText("Отправка настроена")).not.toBeNull();
    expect(screen.queryByText(/Не удалось/)).toBeNull();
  });

  it("problem показывается плоским текстом, без HTML", async () => {
    asClerk();
    mockGet.mockResolvedValue(state({ problem: "Ящик <b>post@mail.test</b> не выбран" }));
    const { container } = render(<ServiceAccountHint />);

    expect(await screen.findByText("Ящик <b>post@mail.test</b> не выбран")).not.toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("удалённый служебный ящик (problemCode account_missing) объясняется словами", async () => {
    asClerk();
    // По решению Lead: configured=true («в настройках что-то выбрано»), но ящика уже нет.
    mockGet.mockResolvedValue(state({ account: null, problem: null, problemCode: "account_missing" }));
    render(<ServiceAccountHint />);

    expect(await screen.findByText(/Выбранный служебный ящик больше не существует/)).not.toBeNull();
  });

  it("ящик не выбран — подсказка говорит, что отправка возьмёт первый ящик с SMTP", async () => {
    asClerk();
    mockGet.mockResolvedValue(state({ configured: false, account: null, problem: null, problemCode: "not_configured" }));
    render(<ServiceAccountHint />);

    expect(await screen.findByText(/Служебный ящик не выбран/)).not.toBeNull();
  });

  it("ошибка загрузки показывается с кнопкой «Повторить», без цикла запросов", async () => {
    asClerk();
    mockGet.mockRejectedValueOnce(new Error("403 Forbidden"));
    render(<ServiceAccountHint />);

    expect(await screen.findByText("Не удалось проверить служебный ящик")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Повторить" })).not.toBeNull();
    await Promise.resolve();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
