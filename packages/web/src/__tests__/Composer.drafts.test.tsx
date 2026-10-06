/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => {
  const actual = jest.requireActual("../api") as Record<string, unknown>;
  return {
    ...actual,
    // Сеть подменяем только на границе: сборку тела запроса проверяем настоящую.
    attachmentBase64: jest.fn(),
    api: {
      accounts: jest.fn(),
      aiConfig: jest.fn(),
      emails: jest.fn(),
      email: jest.fn(),
      threads: jest.fn(),
      templates: jest.fn(),
      drafts: jest.fn(),
      composeTemplate: jest.fn(),
      sendEmail: jest.fn(),
      createDraft: jest.fn(),
      updateDraft: jest.fn(),
      deleteDraft: jest.fn(),
      createTemplate: jest.fn(),
      searchContacts: jest.fn()
    }
  };
});

jest.mock("../components/RichTextEditor", () => ({ __esModule: true, default: () => null }));

import { api, attachmentBase64 } from "../api";
import Composer from "../components/Composer";
import { useStore } from "../store";
import type { Account, Draft } from "../types";

const initial = useStore.getState();

/**
 * Черновик, открытый из списка: вложения уже лежат файлами на сервере, в браузере
 * данных нет — и качать их сюда (20 МБ в base64) незачем.
 */
const draft = {
  id: "draft-1",
  accountId: "acc-1",
  to: [{ address: "client@test.local" }],
  cc: [],
  bcc: [],
  subject: "Черновик с вложениями",
  bodyText: "текст письма",
  bodyHtml: "<p>текст письма</p>",
  attachments: [
    { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 27939, ref: "Договор_копия_.pdf" },
    { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 55032, ref: "Договор_копия_-1.pdf" }
  ],
  inReplyToEmailId: null,
  inReplyToMessageId: null,
  references: [],
  createdAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z"
} as unknown as Draft;

describe("Composer: черновик с вложениями", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      accounts: [{ id: "acc-1", username: "client@test.local", settings: {} } as unknown as Account],
      accountFilter: "acc-1",
      emailView: null,
      compose: { open: true, mode: "new", emailId: null, draft }
    });
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.updateDraft as jest.Mock).mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...draft,
      ...patch,
      id
    }));
    (api.createDraft as jest.Mock).mockImplementation(async (patch: Record<string, unknown>) => ({ ...draft, ...patch }));
    (api.sendEmail as jest.Mock).mockResolvedValue({ emailId: "sent-1", messageId: "<m@test>" });
  });

  it("через 15 секунд автосохранение несёт ссылки, а не base64", async () => {
    jest.useFakeTimers();
    try {
      render(<Composer />);
      await act(async () => {});

      // Вложения черновика видны сразу — с исходным именем, а не «ничего».
      expect(screen.getAllByText("Договор (копия).pdf")).toHaveLength(2);

      await act(async () => {
        jest.advanceTimersByTime(15000);
      });
      await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));

      const patch = (api.updateDraft as jest.Mock).mock.calls[0][1] as { attachments: Array<Record<string, unknown>> };
      expect(patch.attachments).toEqual([
        { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 27939, ref: "Договор_копия_.pdf" },
        { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 55032, ref: "Договор_копия_-1.pdf" }
      ]);
      // ⚠️ Ни одного байта данных: иначе каждые 15 секунд по сети уходили бы десятки МБ.
      expect(JSON.stringify(patch.attachments)).not.toContain("data");
      expect(attachmentBase64).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  }, 20000);

  it("отправка из открытого черновика несёт ссылки, файлы в браузер не качаются", async () => {
    render(<Composer />);
    expect(await screen.findAllByText("Договор (копия).pdf")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));

    await waitFor(() => expect(api.sendEmail).toHaveBeenCalledTimes(1));
    const payload = (api.sendEmail as jest.Mock).mock.calls[0][0] as {
      attachments: Array<Record<string, unknown>>;
    };
    // Ссылка + черновик: содержимое прочитает сервер, браузеру оно не нужно.
    expect(payload.attachments).toEqual([
      { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 27939, ref: "Договор_копия_.pdf", draftId: "draft-1" },
      { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 55032, ref: "Договор_копия_-1.pdf", draftId: "draft-1" }
    ]);
    expect(attachmentBase64).not.toHaveBeenCalled();
  }, 20000);
});
