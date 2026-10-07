/** @jest-environment jsdom */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

// antd Table в jsdom собирается медленно: 1000 мс по умолчанию не хватает.
configure({ asyncUtilTimeout: 8000 });

jest.mock("../api", () => ({
  api: {},
  notificationApi: {
    sortRules: jest.fn(),
    createSortRule: jest.fn(),
    updateSortRule: jest.fn(),
    deleteSortRule: jest.fn(),
    previewSortRule: jest.fn(),
    settings: jest.fn(),
    saveSettings: jest.fn()
  }
}));

import { notificationApi } from "../api";
import { SortingRulesTab } from "../components/sorting/SortingRulesTab";
import type { MailSortRule } from "../types";

const mockRules = notificationApi.sortRules as unknown as jest.Mock;
const mockUpdate = notificationApi.updateSortRule as unknown as jest.Mock;
const mockPreview = notificationApi.previewSortRule as unknown as jest.Mock;

const rule: MailSortRule = {
  id: "rule-1",
  name: "Прокуратура",
  isActive: true,
  sortOrder: 1,
  matchFrom: "ivanov@",
  matchTo: "",
  matchSubject: "обращение",
  label: "Прокуратура",
  priority: 4,
  note: "Проверить срок ответа"
};

describe("вкладка «Правила сортировки»", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    mockRules.mockResolvedValue({ items: [rule] });
    mockPreview.mockResolvedValue({ matched: 12, total: 340, samples: [] });
  });

  it("таблица показывает, что именно ловит правило", async () => {
    render(<SortingRulesTab />);

    // «Прокуратура» встречается и в названии, и в метке — это нормально.
    expect((await screen.findAllByText("Прокуратура")).length).toBeGreaterThan(0);
    expect(screen.getByText("от: ivanov@ · тема содержит: обращение")).not.toBeNull();
    expect(screen.getByText("4 — Высокий")).not.toBeNull();
  });

  it("правило прямо говорит, что документ регистрирует человек, а не правило", async () => {
    render(<SortingRulesTab />);

    expect(
      await screen.findByText(
        /Правило помечает письмо меткой, приоритетом и подсказкой и может поднять его в очереди. Документ по-прежнему регистрирует человек/
      )
    ).not.toBeNull();
  });

  it("переключатель включённости сразу пишет на сервер", async () => {
    render(<SortingRulesTab />);

    fireEvent.click(await screen.findByRole("switch", { name: /Правило «Прокуратура» включено/ }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("rule-1", { isActive: false }));
  });

  it("предпросмотр говорит, сколько писем подходит, и ничего не пишет", async () => {
    render(<SortingRulesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));

    expect(await screen.findByText("Под правило подходят 12 из 340 писем.")).not.toBeNull();
    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({ matchFrom: "ivanov@", matchSubject: "обращение" })
    );
    // Предпросмотр не создаёт правил и не трогает документы.
    expect(notificationApi.createSortRule).not.toHaveBeenCalled();
    expect(notificationApi.deleteSortRule).not.toHaveBeenCalled();
  });

  it("пустой список объясняет, зачем правила нужны", async () => {
    mockRules.mockResolvedValue({ items: [] });
    render(<SortingRulesTab />);

    expect(await screen.findByText("Правил сортировки пока нет")).not.toBeNull();
    // Кнопок «Добавить правило» две (панель действий и пустое состояние) — обе уместны.
    expect(screen.getAllByRole("button", { name: /Добавить правило/ }).length).toBeGreaterThan(0);
  });

  it("нет совпадений — честный текст, а не «0 из 340»", async () => {
    mockPreview.mockResolvedValue({ matched: 0, total: 340, samples: [] });
    render(<SortingRulesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));

    expect(
      await screen.findByText(
        "Под это правило пока не подходит ни одно письмо. Проверьте условия: возможно, они слишком узкие."
      )
    ).not.toBeNull();
  });

  it("образцы показывают метки и приоритет, но не выдуманную дату (§5.1)", async () => {
    mockPreview.mockResolvedValue({
      matched: 1,
      total: 10,
      samples: [
        {
          emailId: "e1",
          subject: "Обращение из прокуратуры",
          from: "ivanov@prok.ru",
          labels: ["Прокуратура"],
          notes: ["Проверить срок ответа по регламенту"],
          priority: 4
        }
      ]
    });
    render(<SortingRulesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));

    expect(await screen.findByText("метки: Прокуратура")).not.toBeNull();
    expect(screen.getByText("приоритет: Высокий")).not.toBeNull();
    expect(screen.getByText("Проверить срок ответа по регламенту")).not.toBeNull();
    // Даты в sample контракт §6 не отдаёт — интерфейс её не рисует.
    expect(screen.queryByText(/\d{2}\.\d{2}\.\d{4}/)).toBeNull();
  });

  it("право отозвали — раздел говорит об этом прямо, без ретраев", async () => {
    mockRules.mockRejectedValue(new Error("403 Forbidden"));
    render(<SortingRulesTab />);

    expect(await screen.findByText("Недостаточно прав для этого раздела")).not.toBeNull();
  });
});
