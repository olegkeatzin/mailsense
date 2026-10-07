/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ api: { journalIncoming: jest.fn() } }));

import { api } from "../api";
import IncomingList from "../components/IncomingList";
import { useStore } from "../store";
import type { IncomingItem } from "../types";

const mockIncoming = api.journalIncoming as unknown as jest.Mock;

function item(patch: Partial<IncomingItem> = {}): IncomingItem {
  return {
    emailId: "e1",
    accountId: "acc-1",
    subject: "Обращение из прокуратуры",
    from: { name: "Иванов", address: "ivanov@prok.ru" },
    date: "2026-10-06T10:00:00.000Z",
    analysisStatus: "ready",
    externalNumber: null,
    sendDate: null,
    summary: "",
    priority: null,
    tags: [],
    attachmentsCount: 0,
    sortLabels: [],
    sortPriority: null,
    sortNotes: [],
    sortMatched: false,
    ...patch
  };
}

describe("«Входящие на регистрацию»: правила только подсказывают", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    useStore.setState({ section: "incoming" });
    mockIncoming.mockResolvedValue({ items: [item()], total: 1 });
  });

  it("подпись прямо говорит, что документ регистрирует человек", async () => {
    render(<IncomingList />);

    expect(
      await screen.findByText(
        /Документ регистрирует человек: правило только помечает письмо меткой и подсказкой и поднимает его в очереди. Номер при этом не выдаётся./
      )
    ).not.toBeNull();
  });

  it("метки, приоритет и подсказка правила видны на карточке", async () => {
    mockIncoming.mockResolvedValue({
      items: [
        item({
          sortLabels: ["Прокуратура"],
          sortPriority: 4,
          sortNotes: ["Проверить срок ответа по регламенту"],
          sortMatched: true
        })
      ],
      total: 1
    });
    render(<IncomingList />);

    expect(await screen.findByText("Прокуратура")).not.toBeNull();
    expect(screen.getByText("правило: Высокий")).not.toBeNull();
    expect(screen.getByText("Подсказка правила")).not.toBeNull();
    expect(screen.getByText("Проверить срок ответа по регламенту")).not.toBeNull();
  });

  it("метка не даёт и не отнимает право зарегистрировать", async () => {
    render(<IncomingList />);

    expect(await screen.findByRole("button", { name: /Зарегистрировать/ })).not.toBeNull();
    // Никакого «зарегистрировать по правилу»: такого действия нет.
    expect(screen.queryByRole("button", { name: /Автоматически/ })).toBeNull();
  });

  it("фильтр «только по правилам» уходит на сервер", async () => {
    render(<IncomingList />);
    await screen.findByText("Обращение из прокуратуры");
    mockIncoming.mockClear();

    fireEvent.click(screen.getByRole("checkbox", { name: "Только по правилам" }));

    await waitFor(() =>
      expect(mockIncoming).toHaveBeenCalledWith({ limit: 200, rulesOnly: true, sort: "date" })
    );
  });

  it("порядок по умолчанию — по дате, переключатель меняет его на правила", async () => {
    render(<IncomingList />);
    await screen.findByText("Обращение из прокуратуры");
    expect(mockIncoming).toHaveBeenCalledWith({ limit: 200, rulesOnly: false, sort: "date" });

    mockIncoming.mockClear();
    fireEvent.click(screen.getByText("По правилам"));

    await waitFor(() => expect(mockIncoming).toHaveBeenCalledWith({ limit: 200, rulesOnly: false, sort: "rules" }));
  });

  it("пусто при фильтре — честный текст и кнопка «Показать все письма»", async () => {
    mockIncoming.mockResolvedValue({ items: [], total: 0 });
    render(<IncomingList />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Только по правилам" }));

    expect(await screen.findByText("Под правила пока не подошло ни одно письмо")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Показать все письма" })).not.toBeNull();
  });

  it("обрезанный список честно говорит, что показаны первые N из total (А6)", async () => {
    mockIncoming.mockResolvedValue({ items: [item(), item({ emailId: "e2" })], total: 340 });
    render(<IncomingList />);

    expect(
      await screen.findByText("Показаны первые 2 из 340. Уточните фильтр или обновите список.")
    ).not.toBeNull();
  });

  it("ошибка загрузки видна в разделе и повторяется кнопкой", async () => {
    mockIncoming.mockRejectedValueOnce(new Error("502 Bad Gateway"));
    render(<IncomingList />);

    expect(await screen.findByText("Не удалось загрузить список")).not.toBeNull();
    expect(screen.getByText("502 Bad Gateway")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Повторить" })).not.toBeNull();
  });
});
