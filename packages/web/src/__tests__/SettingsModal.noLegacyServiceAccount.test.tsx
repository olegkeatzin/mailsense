/** @jest-environment jsdom */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    settings: jest.fn(),
    saveSetting: jest.fn(),
    accounts: jest.fn(),
    aiConfig: jest.fn(),
    promptConfig: jest.fn(),
    templates: jest.fn(),
    directoryStatus: jest.fn(),
    testAi: jest.fn(),
    fetchAccount: jest.fn()
  },
  resolutionApi: { deadlinePresets: jest.fn().mockResolvedValue({ items: [] }) },
  notificationApi: { sortRules: jest.fn(), settings: jest.fn() }
}));

import { api } from "../api";
import SettingsModal from "../components/SettingsModal";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

configure({ asyncUtilTimeout: 8000 });

const initial = useStore.getState();

/**
 * Вкладка «Общие» не должна писать НИ ОДНОЙ настройки документооборота.
 *
 * Раньше здесь жил селектор служебного ящика, писавший свой ключ в настройки ПОЧТЫ.
 * Он перебивал явное снятие выбора в настройках СЭД: агент снимал ящик, а письмо
 * руководителю всё равно уходило первым подходящим. Теперь служебный ящик настраивается
 * только во вкладке «Служебные ящики» через /api/docflow/service-account.
 *
 * Тест намеренно не называет legacy-ключ целиком: проверяем политику «ни одного
 * docflow-ключа из «Общих»», чтобы в проекте не осталось самой строки старого ключа.
 */
describe("настройки: «Общие» не пишут ключи документооборота", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.settings as jest.Mock).mockResolvedValue({ auto_fetch: "true", auto_analyze: "true" });
    (api.saveSetting as jest.Mock).mockResolvedValue({});
    // Реализации задаём здесь, а не в фабрике мока: restoreMocks стирает заданное в фабрике,
    // и метод возвращал undefined — на этом падала кнопка «Проверить» в «Почте».
    (api.fetchAccount as jest.Mock).mockResolvedValue({});
    // Вкладка «ИИ» при открытии читает подсказки промптов и список моделей.
    (api.promptConfig as jest.Mock).mockResolvedValue({});
    (api.testAi as jest.Mock).mockResolvedValue({ ok: true, models: [] });
    (api.accounts as jest.Mock).mockResolvedValue([{ id: "acc-1", username: "post@mail.test" }]);
    useStore.setState({
      ...initial,
      settingsOpen: true,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["settings.manage"], roles: ["admin"] } as unknown as AuthUser
    });
  });

  afterEach(() => {
    useStore.setState({ settingsOpen: false });
  });

  it("поля служебного ящика в «Общих» нет и docflow-ключи отсюда не пишутся", async () => {
    render(<SettingsModal />);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Общие" }));
    expect(await screen.findByText("Автоматическая проверка новой почты")).not.toBeNull();

    expect(screen.queryByText("Служебный ящик аппарата")).toBeNull();
    expect(screen.queryByText(/берётся первый подходящий/)).toBeNull();

    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    const writtenKeys = (api.saveSetting as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(writtenKeys.filter((k) => k.startsWith("docflow."))).toEqual([]);
  });

  it("смена обычной настройки по-прежнему сохраняется", async () => {
    render(<SettingsModal />);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Общие" }));
    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[0]);

    await waitFor(() => expect(api.saveSetting).toHaveBeenCalledWith("auto_fetch", "false"));
  });

  /**
   * T39: у рядового пользователя настройки отвечают 403. Раньше вызов шёл БЕЗ catch —
   * отказ оставался необработанным промисом в консоли, а вкладка молчала. Теперь
   * человек видит объяснение, а консоль чистая.
   */
  it("отказ 403 на настройках: понятный текст вместо необработанного отказа", async () => {
    (api.settings as jest.Mock).mockRejectedValue(new Error("403 Forbidden"));
    render(<SettingsModal />);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Общие" }));

    expect(await screen.findByText(/Недостаточно прав/)).not.toBeNull();
    expect(screen.getByText(/403 Forbidden/)).not.toBeNull();
    // Ничего не записали: без права настройки не меняются.
    expect((api.saveSetting as jest.Mock).mock.calls).toEqual([]);
  });

  it("отказ при сохранении настройки объясняется, а не глотается", async () => {
    (api.saveSetting as jest.Mock).mockRejectedValue(new Error("403 Forbidden"));
    render(<SettingsModal />);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Общие" }));
    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[0]);

    // message.error рисуется порталом в document.body — ищем по всему телу документа.
    await waitFor(() => expect((document.body.textContent ?? "").match(/Недостаточно прав/)).not.toBeNull());
  });
});
