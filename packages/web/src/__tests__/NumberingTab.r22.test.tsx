/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    numbering: jest.fn(),
    saveNumbering: jest.fn(),
    journalArchiveUrl: () => "/api/journal/export?year=2026",
    importJournalArchive: jest.fn()
  }
}));

import { api } from "../api";
import NumberingTab from "../components/NumberingTab";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

const initial = useStore.getState();

/**
 * Р22: журнал — только входящие. Экран нумерации не должен показывать поток «исходящие»
 * и вообще упоминать его: настраивать поток, которого нет в процессе, нельзя.
 */
describe("нумерация: только входящий поток (Р22)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    // Сервер отдаёт ОБА потока — интерфейс обязан показать только входящий.
    (api.numbering as jest.Mock).mockResolvedValue({
      rules: [
        { stream: "incoming", prefix: "вх", reset: "year", template: null },
        { stream: "outgoing", prefix: "исх", reset: "year", template: null }
      ],
      openPeriod: "2026",
      archivedPeriods: [],
      reopenablePeriods: [],
      blockedReason: null
    });
    useStore.setState({
      ...initial,
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as unknown as AuthStatus,
      authUser: { permissions: ["journal.view", "settings.manage"], roles: ["admin"] } as unknown as AuthUser
    });
  });

  it("виден только входящий поток, упоминаний исходящего нет", async () => {
    const { container } = render(<NumberingTab />);

    expect(await screen.findByText("Правило нумерации входящих")).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/исходящ/i);
    expect(text).not.toMatch(/\boutgoing\b/i);
    expect(text).not.toContain("исх");
    // Префикс взят из входящего правила, а не из чужого.
    expect((screen.getByDisplayValue("вх") as HTMLInputElement).value).toBe("вх");
    expect(screen.queryByDisplayValue("исх")).toBeNull();
  });

  it("подпись примера честная: пример не выдан за номер из базы (D7)", async () => {
    const { container } = render(<NumberingTab />);
    await screen.findByText("Правило нумерации входящих");

    const text = container.textContent ?? "";
    expect(text).toMatch(/Пример номера/);
    // Прежняя подпись обещала факт: «Следующий документ получит номер».
    expect(text).not.toMatch(/Следующий документ получит номер/);
  });
});
