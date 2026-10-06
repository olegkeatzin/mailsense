/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({ api: { stopAnalysis: jest.fn() } }));

import { api } from "../api";
import { StopAnalysisButton } from "../components/StopAnalysisButton";
import { useStore } from "../store";

const initial = useStore.getState();

/**
 * «Стоп» стоит рядом с «Анализ» и очищает очередь без возврата: промахнуться легко,
 * а работа теряется. Поэтому подтверждение с ценой нажатия — сколько писем снимется.
 */
describe("остановка анализа", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({ ...initial, analysisQueue: 0, analysisEpoch: 0 });
    (api.stopAnalysis as jest.Mock).mockResolvedValue({ cleared: 3 });
  });

  it("спрашивает подтверждение и показывает, сколько писем будет снято", async () => {
    useStore.setState({ analysisQueue: 3 });
    render(<StopAnalysisButton />);

    fireEvent.click(screen.getByRole("button", { name: /Стоп/ }));

    const dialog = await waitFor(() => document.querySelector(".ant-popconfirm") as HTMLElement);
    expect(dialog.textContent).toContain("3");
    expect(api.stopAnalysis).not.toHaveBeenCalled();
  });

  it("подтверждение останавливает анализ", async () => {
    useStore.setState({ analysisQueue: 2 });
    render(<StopAnalysisButton />);

    fireEvent.click(screen.getByRole("button", { name: /Стоп/ }));
    const dialog = await waitFor(() => document.querySelector(".ant-popconfirm") as HTMLElement);
    const ok = [...dialog.querySelectorAll("button")].find((b) => /Остановить/.test(b.textContent ?? ""));
    fireEvent.click(ok!);

    await waitFor(() => expect(api.stopAnalysis).toHaveBeenCalledTimes(1));
  });

  it("на пустой очереди честно говорит, что снимать нечего", async () => {
    useStore.setState({ analysisQueue: 0 });
    render(<StopAnalysisButton />);

    fireEvent.click(screen.getByRole("button", { name: /Стоп/ }));

    const dialog = await waitFor(() => document.querySelector(".ant-popconfirm") as HTMLElement);
    expect(dialog.textContent).toMatch(/пуста/i);
    expect(api.stopAnalysis).not.toHaveBeenCalled();
  });
});
