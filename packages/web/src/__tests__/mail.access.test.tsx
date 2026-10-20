/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { api, resolutionApi, saveBlob, taskSourceAttachment } from "../api";
import { MailUnavailable } from "../components/MailUnavailable";
import { MyTasks } from "../components/MyTasks";
import SettingsModal from "../components/SettingsModal";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, TaskSourceEmail } from "../types";
import type { TaskItem } from "../resolutionTypes";
import type { MailProfile } from "../types";

const initial = useStore.getState();

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

  it("настройки открываются на запрошенной вкладке (ссылка «Выбрать другой ящик»)", async () => {
    setPermissions([]);
    useStore.setState({ settingsOpen: true, settingsTab: "profile" });
    render(<SettingsModal />);

    // Вкладка «Личные настройки» активна сразу: человек попадает туда, где чинится выбор ящика.
    // У inline-меню выбранный пункт помечается классом antd, а не aria-selected.
    expect(document.querySelector(".ant-menu-item-selected")?.textContent).toContain("Личные настройки");
    expect(await screen.findByText("Почта для СЭД")).not.toBeNull();
    // Просьбу исполнили один раз — дальше вкладками ходит сам человек.
    expect(useStore.getState().settingsTab).toBeNull();
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

  it("в настройках БЕЗ ролей есть и «Почта» (свои ящики), и «Личные настройки»", async () => {
    setPermissions([]);
    useStore.setState({ settingsOpen: true });
    render(<SettingsModal />);

    expect(await screen.findByRole("menuitem", { name: "Личные настройки" })).not.toBeNull();
    // Свой ящик заводят без роли: раздел «Почта» открыт всем.
    expect(await screen.findByRole("menuitem", { name: "Почта" })).not.toBeNull();
  });

  /**
   * Р21: личный адрес сервера — настройка работника, а не администратора.
   * Значит карточка адреса должна быть видна и БЕЗ админских прав.
   */
  it("рядовой работник видит вкладку «Подключение», а админских вкладок у него нет", async () => {
    setPermissions([]);
    useStore.setState({ settingsOpen: true });
    render(<SettingsModal />);

    expect(await screen.findByRole("menuitem", { name: "Подключение" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Документооборот" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Пользователи и роли" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Подключение" }));
    // В браузере моста нет — честный текст вместо поля.
    expect(await screen.findByText(/В браузере адрес задаётся сервером/)).not.toBeNull();
  });

  it("в приложении рядовой работник задаёт СВОЙ адрес сервера", async () => {
    setPermissions([]);
    useStore.setState({ settingsOpen: true });
    const bridge = {
      isElectron: true,
      getServerConfig: jest.fn().mockResolvedValue({
        serverUrl: "http://old:8123",
        source: "user",
        managedByAdmin: false,
        error: null,
        localServerUrl: null
      }),
      setServerUrl: jest.fn().mockResolvedValue({ ok: true, serverUrl: "http://my:9000" }),
      clearServerUrl: jest.fn().mockResolvedValue({ ok: true, serverUrl: null })
    };
    (window as unknown as { mailsense?: unknown }).mailsense = bridge;
    try {
      render(<SettingsModal />);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Подключение" }));
      const input = await screen.findByLabelText("Адрес сервера");
      fireEvent.change(input, { target: { value: "http://my:9000" } });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить адрес" }));

      await waitFor(() => expect(bridge.setServerUrl).toHaveBeenCalledWith("http://my:9000"));
    } finally {
      delete (window as unknown as { mailsense?: unknown }).mailsense;
    }
  });

  it("исполнителю «Письмо» из задачи открывает письмо-источник, а не почтовый раздел", async () => {
    setPermissions(["task.view"]);
    const letter: TaskSourceEmail = {
      resolutionId: "res-1",
      emailId: "mail-1",
      subject: "Вопрос о поставке",
      from: { address: "client@outside.test", name: "Клиент" },
      to: [],
      cc: [],
      date: "2026-10-07T09:00:00.000Z",
      bodyText: "текст письма",
      bodyHtml: null,
      attachments: [{ id: "a-1", filename: "приказ.pdf", mimeType: "application/pdf", size: 1024 }]
    } as unknown as TaskSourceEmail;
    (resolutionApi.sourceEmail as jest.Mock).mockResolvedValue(letter);
    (resolutionApi.myTasks as jest.Mock).mockResolvedValue([
      {
        resolutionId: "res-1",
        documentId: "doc-1",
        documentNumber: "вх38",
        emailId: "mail-1",
        text: "Подготовить ответ",
        kind: "executor",
        priority: "normal",
        deadline: null,
        daysLeft: null,
        overdue: false,
        dueSoon: false,
        receivedAt: null,
        reportAt: null,
        reportText: null
      } as unknown as TaskItem
    ]);

    render(<MyTasks />);
    fireEvent.click(await screen.findByRole("button", { name: "Письмо" }));

    await waitFor(() => expect(resolutionApi.sourceEmail).toHaveBeenCalledWith("res-1"));
    // Общий почтовый маршрут не трогаем: у исполнителя на него нет права.
    expect(api.email).not.toHaveBeenCalled();
    expect(await screen.findByText("Вопрос о поставке")).not.toBeNull();
    expect(await screen.findByText("текст письма")).not.toBeNull();

    // Вложения: не просто имена — их можно открыть и скачать (маршрут по поручению).
    expect(await screen.findByText("приказ.pdf")).not.toBeNull();
    (taskSourceAttachment as jest.Mock).mockResolvedValue(new Blob(["данные"]));
    fireEvent.click(screen.getByRole("button", { name: /Скачать/ }));
    await waitFor(() => expect(taskSourceAttachment).toHaveBeenCalledWith("res-1", "a-1"));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
  });
});

/**
 * Исполнитель с собственной почтой открывает НАСТОЯЩЕЕ письмо из своего ящика:
 * сервер отдаёт ownEmailId — копию письма о поручении.
 */
describe("задача: открыть письмо в почте", () => {
  beforeAll(installDomEnvironment);

  const letter = {
    resolutionId: "res-1",
    emailId: "mail-1",
    subject: "Поручение по документу вх38",
    from: { address: "apparat@mail.test" },
    to: [],
    cc: [],
    date: "2026-10-20T10:00:00.000Z",
    bodyText: "текст",
    bodyHtml: null,
    attachments: [],
    ownEmailId: "mail-own-1"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (resolutionApi.sourceEmail as jest.Mock).mockResolvedValue(letter);
    (resolutionApi.myTasks as jest.Mock).mockResolvedValue([
      {
        resolutionId: "res-1",
        documentId: "doc-1",
        documentNumber: "вх38",
        emailId: "mail-1",
        text: "Подготовить ответ",
        kind: "executor",
        priority: "normal",
        deadline: null,
        daysLeft: null,
        overdue: false,
        dueSoon: false,
        receivedAt: null,
        reportAt: null,
        reportText: null
      } as unknown as TaskItem
    ]);
    useStore.setState({
      ...useStore.getState(),
      accounts: [{ id: "acc-1", username: "executor@mail.test", settings: {} } as never],
      docflowUnavailable: false,
      authUser: { permissions: ["task.view"], roles: ["executor"], fullName: "Петрова М." } as never
    });
    (api.email as jest.Mock).mockResolvedValue({ id: "mail-own-1" });
  });

  it("кнопка открывает письмо из своего ящика", async () => {
    render(<MyTasks />);
    fireEvent.click(await screen.findByRole("button", { name: "Письмо" }));
    const open = await screen.findByRole("button", { name: "Открыть в почте" });
    fireEvent.click(open);

    await waitFor(() => expect(api.email).toHaveBeenCalledWith("mail-own-1", expect.anything()));
    expect(useStore.getState().section).toBe("mail");
  });
});
