/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    emails: jest.fn(),
    threads: jest.fn(),
    email: jest.fn(),
    bulkAnalyze: jest.fn(),
    bulkFolder: jest.fn(),
    bulkDelete: jest.fn()
  }
}));

import { api } from "../api";
import BulkBar from "../components/BulkBar";
import EmailList from "../components/EmailList";
import FilterBar from "../components/FilterBar";
import { useStore } from "../store";
import type { Email } from "../types";

const mockEmails = api.emails as unknown as jest.Mock;

function mail(id: string, subject: string): Email {
  return { id, subject, bodyText: "", analysisStatus: "pending" } as unknown as Email;
}

const initial = useStore.getState();

/** Список писем вместе с полосой выбора и фильтрами — как на экране почты. */
function renderMailScreen() {
  return render(
    <>
      <FilterBar />
      <BulkBar />
      <EmailList />
    </>
  );
}

/**
 * Ссылки на узлы списка живут до первой перерисовки (появляется полоса выбора —
 * react-window перерисовывает строки), поэтому каждый раз ищем заново по имени.
 */
function clickLetter(subject: string) {
  fireEvent.click(screen.getByLabelText("Выбрать письмо: " + subject));
}

function letterChecked(subject: string): boolean {
  return (screen.getByLabelText("Выбрать письмо: " + subject) as HTMLInputElement).checked;
}

describe("EmailList: выбор и полоса массовых действий", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      emails: [mail("a", "Письмо про отчёт"), mail("b", "Письмо про бумагу"), mail("c", "Письмо про акт")],
      threads: [],
      threadView: false,
      selectedId: null,
      emailView: null,
      selectedIds: [],
      folder: "INBOX",
      accountFilter: null,
      q: "",
      loading: false
    });
    mockEmails.mockResolvedValue([]);
  });

  it("«Выбрано: N» показывает ровно столько писем, сколько отмечено", async () => {
    renderMailScreen();
    await screen.findAllByLabelText(/^Выбрать письмо/);

    clickLetter("Письмо про отчёт");
    clickLetter("Письмо про бумагу");

    expect(await screen.findByText("Выбрано: 2")).toBeTruthy();
    expect(letterChecked("Письмо про отчёт")).toBe(true);
    expect(letterChecked("Письмо про бумагу")).toBe(true);
    expect(letterChecked("Письмо про акт")).toBe(false);
  });

  it("смена фильтра сбрасывает выбор: письма с экрана ушли — действия по ним не уйдут", async () => {
    renderMailScreen();
    await screen.findAllByLabelText(/^Выбрать письмо/);

    clickLetter("Письмо про отчёт");
    clickLetter("Письмо про бумагу");
    expect(await screen.findByText("Выбрано: 2")).toBeTruthy();

    // Пользователь уточнил поиск: список на экране другой.
    mockEmails.mockResolvedValue([mail("a", "Письмо про отчёт")]);
    await act(async () => {
      useStore.getState().setFilter({ q: "отчёт" });
    });

    await waitFor(() => expect(screen.queryByText(/Выбрано:/)).toBeNull());
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("«Все» отмечает весь видимый список, а не только то, что было выбрано раньше", async () => {
    renderMailScreen();

    fireEvent.click(await screen.findByLabelText("Все"));

    expect(await screen.findByText("Выбрано: 3")).toBeTruthy();
    expect(useStore.getState().selectedIds.filter((id) => ["a", "b", "c"].includes(id))).toHaveLength(3);
  });
});
