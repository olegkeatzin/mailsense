/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

import { ServerAddressCard } from "../components/ServerAddressCard";
import type { MailsenseBridge, ServerConfig } from "../ipc";

const baseConfig: ServerConfig = {
  serverUrl: "http://server:8123",
  source: "user",
  managedByAdmin: false,
  error: null,
  localServerUrl: null
};

function installBridge(overrides: Partial<MailsenseBridge> = {}, config: ServerConfig = baseConfig): MailsenseBridge {
  const bridge: MailsenseBridge = {
    isElectron: true,
    getServerConfig: jest.fn().mockResolvedValue(config),
    setServerUrl: jest.fn().mockResolvedValue({ ok: true, serverUrl: config.serverUrl }),
    clearServerUrl: jest.fn().mockResolvedValue({ ok: true, serverUrl: null }),
    ...overrides
  };
  (window as unknown as { mailsense?: MailsenseBridge }).mailsense = bridge;
  return bridge;
}

describe("адрес сервера: источник, запрет администратора, честная ошибка (T43)", () => {
  beforeAll(installDomEnvironment);

  afterEach(() => {
    delete (window as unknown as { mailsense?: MailsenseBridge }).mailsense;
  });

  it("показывает источник адреса человеческим текстом по каждому варианту", async () => {
    const cases: Array<[ServerConfig["source"], RegExp]> = [
      ["arg", /задан параметром запуска/],
      ["install", /задан администратором \(файл рядом с программой\)/],
      ["user", /задан в личных настройках/],
      ["env", /задан переменной окружения/],
      [null, /не задан — автономный режим/]
    ];
    for (const [source, expected] of cases) {
      installBridge({}, { ...baseConfig, source });
      const view = render(<ServerAddressCard />);
      expect(await view.findByText(expected)).not.toBeNull();
      view.unmount();
    }
  });

  it("админский адрес: поле только для чтения, надпись есть, кнопки неактивны", async () => {
    installBridge({}, { ...baseConfig, source: "install", managedByAdmin: true });
    render(<ServerAddressCard />);

    expect(await screen.findByText("Адрес задан администратором — изменить нельзя")).not.toBeNull();
    const input = screen.getByLabelText("Адрес сервера") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "Сохранить адрес" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Сбросить" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ошибка конфигурации видна и НЕ выдаётся за «подключено»", async () => {
    installBridge({}, { ...baseConfig, serverUrl: null, source: "install", error: "server.json: не разобран адрес" });
    render(<ServerAddressCard />);

    expect(await screen.findByText("server.json: не разобран адрес")).not.toBeNull();
    expect(screen.getByText(/работает автономно/)).not.toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/подключено/i);
  });

  it("сохранение и сброс вызываются через IPC, с предупреждением о перезапуске", async () => {
    const bridge = installBridge();
    render(<ServerAddressCard />);
    await screen.findByLabelText("Адрес сервера");

    fireEvent.change(screen.getByLabelText("Адрес сервера"), { target: { value: "http://new-server:9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить адрес" }));
    await waitFor(() => expect(bridge.setServerUrl).toHaveBeenCalledWith("http://new-server:9000"));
    expect(await screen.findByText(/Перезапустите приложение/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(bridge.clearServerUrl).toHaveBeenCalledTimes(1));
  });

  it("пустой адрес — автономный режим, а не пустое место", async () => {
    installBridge({}, { ...baseConfig, serverUrl: null, source: null });
    render(<ServerAddressCard />);

    expect(await screen.findByText(/Текущий адрес: не задан/)).not.toBeNull();
    expect(screen.getByText(/не задан — автономный режим/)).not.toBeNull();
  });

  it("в браузере моста нет — говорим об этом честно, без падения", async () => {
    render(<ServerAddressCard />);

    expect(await screen.findByText(/В браузере адрес задаётся сервером/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить адрес" })).toBeNull();
  });

  it("отказ сервера показывается его же словами, а не молчанием", async () => {
    const bridge = installBridge({
      // Отказ не про права, а про сам адрес: кнопка доступна, значит сообщение обязано дойти.
      setServerUrl: jest.fn().mockResolvedValue({ ok: false, error: "Адрес должен начинаться с http" })
    });
    render(<ServerAddressCard />);
    await screen.findByLabelText("Адрес сервера");

    fireEvent.click(screen.getByRole("button", { name: "Сохранить адрес" }));

    await waitFor(() => expect(bridge.setServerUrl).toHaveBeenCalledTimes(1));
    // message.error рисуется порталом в document.body.
    await waitFor(() =>
      expect((document.body.textContent ?? "").match(/Адрес должен начинаться с http/)).not.toBeNull()
    );
    // Отказ сервера не ломает форму: кнопка на месте.
    expect(screen.getByRole("button", { name: "Сохранить адрес" })).not.toBeNull();
  });
});
