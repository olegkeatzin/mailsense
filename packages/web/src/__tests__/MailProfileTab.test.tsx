/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: { mailProfile: jest.fn(), saveMailProfile: jest.fn() }
}));

import { api } from "../api";
import { MailProfileTab } from "../components/MailProfileTab";
import type { MailProfile } from "../types";

const mockGet = api.mailProfile as unknown as jest.Mock;
const mockPut = api.saveMailProfile as unknown as jest.Mock;

const filled: MailProfile = {
  userId: "u-petrova",
  displayName: "Петрова Мария",
  signatureText: "С уважением,\nМария Петрова",
  signatureEnabled: true,
  signaturePosition: "above",
  replyQuote: false,
  replyAttribution: "en",
  updatedAt: "2026-10-07T09:00:00.000Z"
};

/** Пустой профиль: подпись не задана, но это не ошибка. */
const empty: MailProfile = {
  userId: "u-petrova",
  displayName: "",
  signatureText: "",
  signatureEnabled: true,
  signaturePosition: "below",
  replyQuote: true,
  replyAttribution: "ru",
  updatedAt: null
};

describe("личные настройки почты (T36)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(filled);
    mockPut.mockResolvedValue(filled);
  });

  it("показывает сохранённые личные настройки", async () => {
    render(<MailProfileTab />);

    await waitFor(() => expect((screen.getByLabelText("Имя подписи") as HTMLInputElement).value).toBe("Петрова Мария"));
    expect((screen.getByLabelText("Текст подписи") as HTMLTextAreaElement).value).toContain("Мария Петрова");
    // Положение подписи «до цитаты» и английская атрибуция видны в форме.
    expect(screen.getByText("До цитаты письма")).not.toBeNull();
    expect(screen.getByText(/Английская/)).not.toBeNull();
  });

  it("сохранение отправляет поля профиля как есть (camelCase)", async () => {
    render(<MailProfileTab />);
    await waitFor(() => expect((screen.getByLabelText("Имя подписи") as HTMLInputElement).value).toBe("Петрова Мария"));

    fireEvent.change(screen.getByLabelText("Имя подписи"), { target: { value: "Иванов И.И." } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({
        displayName: "Иванов И.И.",
        signatureText: "С уважением,\nМария Петрова",
        signatureEnabled: true,
        signaturePosition: "above",
        replyQuote: false,
        replyAttribution: "en"
      })
    );
  });

  it("пустой профиль честно говорит, что подпись не задана", async () => {
    mockGet.mockResolvedValue(empty);
    render(<MailProfileTab />);

    expect(await screen.findByText("Подпись не задана")).not.toBeNull();
    expect(screen.getByText(/в окне письма подпись не подставляется/)).not.toBeNull();
  });

  it("недоступный профиль показывает русское объяснение с повтором", async () => {
    mockGet.mockRejectedValue(new Error("401 Unauthorized"));
    render(<MailProfileTab />);

    expect(await screen.findByText("Не удалось загрузить личные настройки")).not.toBeNull();
    expect(screen.getByText(/Нужно войти заново/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Повторить" })).not.toBeNull();
  });
});
