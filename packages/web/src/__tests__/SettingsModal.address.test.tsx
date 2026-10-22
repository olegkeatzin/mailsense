/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn(),
    mailDefaults: jest.fn().mockResolvedValue({}),
    settings: jest.fn(),
    saveSetting: jest.fn(),
    templates: jest.fn(),
    directoryStatus: jest.fn(),
    mailProfile: jest.fn()
  },
  resolutionApi: { myEdmsMail: jest.fn(), saveMyEdmsMail: jest.fn() },
  notificationApi: { sortRules: jest.fn(), settings: jest.fn() }
}));

import { api } from "../api";
import SettingsModal from "../components/SettingsModal";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

/**
 * Личный адрес сервера (Р21) — отдельный файл: тест подменяет window.mailsense
 * и кликает по вкладке. В общем наборе он наследовал состояние предыдущих тестов.
 */
const initial = useStore.getState();

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  (api.accounts as jest.Mock).mockResolvedValue([]);
  (api.mailDefaults as jest.Mock).mockResolvedValue({});
  (api.settings as jest.Mock).mockResolvedValue({});
  useStore.setState({
    ...initial,
    authReady: true,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: [], roles: [], fullName: "Мария Петрова" } as unknown as AuthUser,
    settingsOpen: true
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ ...initial });
});

it("в приложении рядовой работник задаёт СВОЙ адрес сервера", async () => {
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
