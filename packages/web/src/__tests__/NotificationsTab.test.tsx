/** @jest-environment jsdom */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

// antd Table в jsdom собирается медленно: 1000 мс по умолчанию не хватает.
configure({ asyncUtilTimeout: 8000 });

jest.mock("../api", () => ({
  api: {},
  notificationApi: {
    settings: jest.fn(),
    saveSettings: jest.fn(),
    sortRules: jest.fn(),
    createSortRule: jest.fn(),
    updateSortRule: jest.fn(),
    deleteSortRule: jest.fn(),
    previewSortRule: jest.fn()
  }
}));

import { notificationApi } from "../api";
import { NotificationsTab } from "../components/sorting/NotificationsTab";
import type { NotificationSettings } from "../types";

const mockSettings = notificationApi.settings as unknown as jest.Mock;
const mockSave = notificationApi.saveSettings as unknown as jest.Mock;

const settings: NotificationSettings = {
  enabled: true,
  dueSoonDays: 3,
  workdayDeadlines: true,
  holidays: [],
  variables: [
    { key: "regNumber", title: "Номер документа" },
    { key: "daysLeft", title: "Осталось дней" }
  ],
  templates: [
    { key: "resolution.assigned", title: "Вам поручение: {text}", body: "", isActive: true, updatedAt: "2026-10-07T00:00:00.000Z" },
    { key: "resolution.overdue", title: "Просрочено: {daysLeft}", body: "", isActive: false, updatedAt: "2026-10-07T00:00:00.000Z" }
  ]
};

describe("вкладка «Уведомления»", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    mockSettings.mockResolvedValue(settings);
    mockSave.mockResolvedValue({ ok: true });
  });

  it("показывает порог и шаблоны с русскими названиями видов", async () => {
    render(<NotificationsTab />);

    expect(await screen.findByText("Показывать уведомления в приложении")).not.toBeNull();
    expect(screen.getByText("Вам поручение")).not.toBeNull();
    expect(screen.getByText("Срок просрочен")).not.toBeNull();
    expect(screen.getByText("выключен")).not.toBeNull();
  });

  it("«Сохранить настройки» отправляет выключатель, порог и рабочие дни", async () => {
    render(<NotificationsTab />);

    // Первый switch — выключатель уведомлений, второй — рабочие дни.
    fireEvent.click((await screen.findAllByRole("switch"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки" }));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith({
        enabled: false,
        dueSoonDays: 3,
        workdayDeadlines: true,
        holidays: []
      })
    );
  });

  it("праздничные дни уходят по одной дате в строке (А3)", async () => {
    render(<NotificationsTab />);

    const area = await screen.findByLabelText("Праздничные дни");
    fireEvent.change(area, { target: { value: "2026-01-01\n2026-01-07" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки" }));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ holidays: ["2026-01-01", "2026-01-07"] }))
    );
  });

  it("кривая дата не уходит на сервер", async () => {
    render(<NotificationsTab />);

    const area = await screen.findByLabelText("Праздничные дни");
    fireEvent.change(area, { target: { value: "01.01.2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки" }));

    await waitFor(() => expect(mockSave).not.toHaveBeenCalled());
  });

  it("шаблон правится и сохраняется", async () => {
    render(<NotificationsTab />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Изменить" }))[0]);
    const title = await screen.findByLabelText("Заголовок шаблона");
    fireEvent.change(title, { target: { value: "Новый текст поручения" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith({
        templates: expect.arrayContaining([
          expect.objectContaining({ key: "resolution.assigned", title: "Новый текст поручения" })
        ])
      })
    );
  });

  it("право отозвали — честное сообщение без повторов", async () => {
    mockSettings.mockRejectedValue(new Error("403 Forbidden"));
    render(<NotificationsTab />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
    expect(mockSettings).toHaveBeenCalledTimes(1);
  });
});
