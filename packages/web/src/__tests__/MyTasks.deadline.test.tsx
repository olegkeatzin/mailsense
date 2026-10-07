/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {},
  resolutionApi: { myTasks: jest.fn(), markReceived: jest.fn(), icsUrl: (id: string) => "/ics/" + id }
}));

import { resolutionApi } from "../api";
import { MyTasks } from "../components/MyTasks";
import type { TaskItem } from "../resolutionTypes";

const mockTasks = resolutionApi.myTasks as unknown as jest.Mock;

function task(patch: Partial<TaskItem> = {}): TaskItem {
  return {
    resolutionId: "res-1",
    kind: "responsible",
    text: "Подготовить ответ",
    priority: "normal",
    deadline: "2026-10-10",
    receivedAt: "2026-10-07T09:00:00.000Z",
    reportAt: null,
    reportText: null,
    documentId: "doc-1",
    documentNumber: "вх38",
    documentSummary: "Обращение",
    emailId: null,
    overdue: false,
    daysLeft: 10,
    dueSoon: false,
    ...patch
  };
}

describe("срок в «Моих задачах»", () => {
  beforeAll(installDomEnvironment);

  it("просрочка называет число дней", async () => {
    mockTasks.mockResolvedValue([task({ overdue: true, daysLeft: -3, dueSoon: false, deadline: "2026-10-04" })]);
    render(<MyTasks />);

    expect(await screen.findByText("просрочено на 3 дня")).not.toBeNull();
    expect(screen.getByText("04.10.2026")).not.toBeNull();
  });

  it("предупреждение приходит по серверному dueSoon, а не по своему порогу", async () => {
    mockTasks.mockResolvedValue([task({ daysLeft: 7, dueSoon: true, deadline: "2026-10-14" })]);
    render(<MyTasks />);

    expect(await screen.findByText("осталось 7 дней")).not.toBeNull();
  });

  it("без серверного dueSoon плашки нет, даже если дней мало", async () => {
    mockTasks.mockResolvedValue([task({ daysLeft: 2, dueSoon: false, deadline: "2026-10-09" })]);
    render(<MyTasks />);

    expect(await screen.findByText("09.10.2026")).not.toBeNull();
    expect(screen.queryByText(/остал/)).toBeNull();
  });

  it("день срока — «срок сегодня»", async () => {
    mockTasks.mockResolvedValue([task({ daysLeft: 0, dueSoon: true, deadline: "2026-10-07" })]);
    render(<MyTasks />);

    expect(await screen.findByText("срок сегодня")).not.toBeNull();
  });

  it("срок не указан — честный текст, а не пустая ячейка", async () => {
    mockTasks.mockResolvedValue([task({ deadline: null, daysLeft: null, dueSoon: false })]);
    render(<MyTasks />);

    expect(await screen.findByText("не указан")).not.toBeNull();
  });

  it("кнопка «В календарь» остаётся единственным напоминанием вне приложения (Р11)", async () => {
    mockTasks.mockResolvedValue([task()]);
    render(<MyTasks />);

    const link = await screen.findByRole("link", { name: "В календарь" });
    expect(link.getAttribute("href")).toBe("/ics/res-1");
  });
});
