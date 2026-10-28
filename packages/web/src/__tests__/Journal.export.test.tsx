/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    journal: jest.fn(),
    journalStatusCounts: jest.fn(),
    journalExport: jest.fn()
  },
  saveBlob: jest.fn()
}));

import { api, saveBlob } from "../api";
import Journal from "../components/Journal";
import { useStore } from "../store";

const initial = useStore.getState();

describe("выгрузка журнала в Excel", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      authStatus: { docflowEnabled: true } as never,
      authUser: { id: "u-secretary", permissions: ["journal.view"], roles: ["secretary"] } as never,
      section: "journal"
    });
    (api.journal as jest.Mock).mockResolvedValue({ items: [], total: 0 });
    (api.journalStatusCounts as jest.Mock).mockResolvedValue({});
    (api.journalExport as jest.Mock).mockResolvedValue({
      blob: new Blob(["xlsx"]),
      filename: "журнал-2026.xlsx"
    });
  });

  it("скачивает файл с сессией, а не открывает /api в браузере", async () => {
    render(<Journal />);
    const button = await screen.findByRole("button", { name: /Выгрузить в Excel/ });

    expect(button.getAttribute("href")).toBeNull();
    fireEvent.click(button);

    await waitFor(() => expect(api.journalExport).toHaveBeenCalledTimes(1));
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "журнал-2026.xlsx");
  });
});
