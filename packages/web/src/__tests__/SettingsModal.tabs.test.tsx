/** @jest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn(),
    mailDefaults: jest.fn().mockResolvedValue({}),
    settings: jest.fn(),
    saveSetting: jest.fn(),
    templates: jest.fn(),
    directoryStatus: jest.fn(),
    mailProfile: jest.fn(),
    aiConfig: jest.fn(),
    promptConfig: jest.fn(),
    authStatus: jest.fn()
  },
  resolutionApi: {
    myEdmsMail: jest.fn(),
    saveMyEdmsMail: jest.fn()
  },
  notificationApi: { sortRules: jest.fn(), settings: jest.fn() }
}));

import { api } from "../api";
import SettingsModal from "../components/SettingsModal";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, MailProfile } from "../types";

/**
 * Вкладки настроек по правам — отдельный файл.
 *
 * В общем наборе каждый следующий тест после SettingsModal замедлялся в разы:
 * AntD-табы и формы оставляют после себя глобальные таймеры/порталы, и на десятом
 * тесте файл шёл уже десятки секунд. Свежий процесс на файл — дешевле.
 */
const initial = useStore.getState();

function setPermissions(permissions: string[]) {
  useStore.setState({
    ...initial,
    authReady: true,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["executor"], fullName: "Мария Петрова" } as unknown as AuthUser
  });
}

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (api.accounts as jest.Mock).mockResolvedValue([]);
  (api.mailDefaults as jest.Mock).mockResolvedValue({});
  (api.settings as jest.Mock).mockResolvedValue({});
  (api.directoryStatus as jest.Mock).mockResolvedValue({ loggedIn: false, login: null, contacts: 0 });
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
});

afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
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

it("с правом settings.manage вкладка «Нумерация» видна даже без журнала", async () => {
  setPermissions(["settings.manage"]);
  useStore.setState({ settingsOpen: true });
  render(<SettingsModal />);

  expect(await screen.findByRole("menuitem", { name: "Нумерация" })).not.toBeNull();
});
