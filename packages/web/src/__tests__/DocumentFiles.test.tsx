/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => ({
  api: {
    journalFiles: jest.fn(),
    journalFileBlob: jest.fn()
  }
}));

import { api } from "../api";
import { DocumentFilesButton } from "../components/DocumentFiles";

describe("вложения документа в журнале", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (api.journalFiles as jest.Mock).mockResolvedValue({
      docFilesPath: "/app/mailDocs/вх12026_27.10.2026",
      files: [{ name: "Приглашение.pdf", size: 2048 }]
    });
    (api.journalFileBlob as jest.Mock).mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    Object.defineProperty(URL, "createObjectURL", { writable: true, value: jest.fn(() => "blob:doc") });
    Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: jest.fn() });
  });

  it("показывает папку и скачивает вложение", async () => {
    render(<DocumentFilesButton documentId="doc-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Файлы/ }));

    expect(await screen.findByText(/вх12026_27.10.2026/)).not.toBeNull();
    expect(await screen.findByText("Приглашение.pdf")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Скачать/ }));
    await waitFor(() => expect(api.journalFileBlob).toHaveBeenCalledWith("doc-1", "Приглашение.pdf"));
  });
});
