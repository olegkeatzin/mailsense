/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    emails: jest.fn(),
    mailDefaults: jest.fn().mockResolvedValue({}),
    accounts: jest.fn(),
    email: jest.fn(),
    settings: jest.fn(),
    saveSetting: jest.fn(),
    templates: jest.fn(),
    directoryStatus: jest.fn(),
    aiConfig: jest.fn(),
    promptConfig: jest.fn(),
    testAi: jest.fn(),
    mailProfile: jest.fn(),
    fetchAccount: jest.fn(),
    authStatus: jest.fn(),
    logout: jest.fn()
  },
  resolutionApi: {
    myTasks: jest.fn(),
    markReceived: jest.fn(),
    sourceEmail: jest.fn(),
    icsUrl: () => "",
    // Вкладка «Личные настройки» содержит раздел «Почта для СЭД» — он читает выбор ящика.
    myEdmsMail: jest.fn(),
    saveMyEdmsMail: jest.fn()
  },
  notificationApi: { list: jest.fn(), sortRules: jest.fn(), settings: jest.fn() },
  // Вложения письма-источника в задаче: файл берётся маршрутом по поручению.
  taskSourceAttachment: jest.fn(),
  saveBlob: jest.fn(),
  bytesToBase64: jest.fn(() => "AA==")
}));

import { api, resolutionApi } from "../api";
import { MailUnavailable } from "../components/MailUnavailable";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";
import type { MailProfile } from "../types";

const initial = useStore.getState();

/**
 * Каждый тест начинает с чистого стора и пустого DOM.
 *
 * Без этого состояние протекало в следующий тест: открытая модалка первого теста
 * оставляла портал, и последний тест ждал свою модалку 8 секунд, хотя в одиночку
 * проходил за секунду. Это не «медленный тест», а грязный.
 */
afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
});

/** Сессия с указанным набором прав: документооборот включён. */
function setPermissions(permissions: string[]) {
  useStore.setState({
    ...initial,
    authReady: true,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["executor"], fullName: "Мария Петрова" } as unknown as AuthUser
  });
}

describe("доступ к почте по правам (T44)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.accounts as jest.Mock).mockResolvedValue([]);
    (api.mailProfile as jest.Mock).mockResolvedValue({
      userId: "u-1",
      displayName: "",
      signatureText: "",
      signatureEnabled: true,
      signaturePosition: "below",
      replyQuote: true,
      replyAttribution: "ru",
      updatedAt: null
    } as MailProfile);
    (resolutionApi.myTasks as jest.Mock).mockResolvedValue([]);
    (resolutionApi.markReceived as jest.Mock).mockResolvedValue({});
  });

  it("почта доступна ЛЮБОМУ вошедшему: прав на почту у ролей больше нет", () => {
    // ⚠️ Раньше здесь требовались mail.view/mail.send, и человек без ролей не мог открыть
    // даже свой ящик. Теперь граница — владелец ящика на сервере (docs/design/mail-ownership.md).
    setPermissions(["task.view"]);
    expect(useStore.getState().canUseMail()).toBe(true);
    expect(useStore.getState().canSendMail()).toBe(true);

    setPermissions([]);
    expect(useStore.getState().canUseMail()).toBe(true);
    expect(useStore.getState().canSendMail()).toBe(true);

    // Автономный режим: документооборот включён, но сервер недоступен — почта работает.
    useStore.setState({ docflowUnavailable: true });
    expect(useStore.getState().canUseMail()).toBe(true);

    // Документооборот выключен — ограничений нет.
    useStore.setState({ docflowUnavailable: false, authStatus: { docflowEnabled: false } as unknown as AuthStatus });
    expect(useStore.getState().canUseMail()).toBe(true);
  });

  it("без ролей письма и ящики всё равно загружаются — это свои данные", async () => {
    setPermissions([]);
    await useStore.getState().init();
    await useStore.getState().loadEmails();

    expect(api.accounts).toHaveBeenCalled();
    expect(api.emails).toHaveBeenCalled();
  });



  it("экран объяснения: честный текст и личные разделы на месте", async () => {
    setPermissions(["task.view"]);
    render(<MailUnavailable />);

    expect(await screen.findByText("Почта недоступна")).not.toBeNull();
    expect(
      screen.getByText("Служебной почтой работают аппарат и администратор. Ваше поручение открывается в разделе «Мои задачи».")
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /Черновики/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Личные настройки/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Мои задачи/ })).not.toBeNull();
  });

  it("без права task.view кнопки «Мои задачи» нет, личные разделы остаются", async () => {
    setPermissions([]);
    render(<MailUnavailable />);

    expect(await screen.findByText("Почта недоступна")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Мои задачи/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Личные настройки/ })).not.toBeNull();
  });

  it("черновики открываются с экрана объяснения (личное доступно всегда)", async () => {
    setPermissions([]);
    render(<MailUnavailable />);

    fireEvent.click(await screen.findByRole("button", { name: /Черновики/ }));
    expect(useStore.getState().draftsOpen).toBe(true);
  });

});
