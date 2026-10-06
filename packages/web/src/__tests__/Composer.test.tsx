/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => {
  const actual = jest.requireActual("../api") as Record<string, unknown>;
  return {
    ...actual,
    // Сеть подменяем только на границе: materializeAttachments остаётся настоящим —
    // именно он отвечает за то, чтобы вложение не потерялось по дороге.
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

// Редактор текста (tiptap) в jsdom работает крайне медленно и к теме теста не относится:
// проверяем вложения, поэтому подменяем сам виджет, а не его поведение.
jest.mock("../components/RichTextEditor", () => ({ __esModule: true, default: () => null }));

import { api, attachmentBase64 } from "../api";
import Composer from "../components/Composer";
import { useStore } from "../store";
import type { Account, ComposeTemplate } from "../types";

const initial = useStore.getState();

/** Шаблон пересылки: вложение приходит ССЫЛКОЙ на файл исходного письма. */
const forwardTemplate = {
  accountId: "acc-1",
  mode: "forward",
  to: [{ address: "user2@mail.test" }],
  cc: [],
  bcc: [],
  subject: "Fwd: Приказ о поставке",
  bodyText: "текст пересылаемого письма",
  bodyHtml: "<p>текст пересылаемого письма</p>",
  inReplyToEmailId: "mail-1",
  inReplyToMessageId: null,
  references: [],
  attachments: [
    {
      filename: "приказ №1 (кириллица).pdf",
      mimeType: "application/pdf",
      size: 2048,
      emailId: "mail-1",
      attachmentId: "att-1"
    }
  ]
} as unknown as ComposeTemplate;

describe("Composer: вложение пересылки не теряется", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      accounts: [{ id: "acc-1", username: "user2@mail.test", settings: {} } as unknown as Account],
      accountFilter: "acc-1",
      emailView: null,
      compose: { open: true, mode: "forward", emailId: "mail-1", draft: null }
    });
    (api.composeTemplate as jest.Mock).mockResolvedValue(forwardTemplate);
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.sendEmail as jest.Mock).mockResolvedValue({ emailId: "sent-1", messageId: "<m@test>" });
    (attachmentBase64 as jest.Mock).mockResolvedValue("BASE64-ФАЙЛА");
  });

  it("вложение видно в окне пересылки — с исходным именем", async () => {
    render(<Composer />);

    expect(await screen.findByText("приказ №1 (кириллица).pdf")).toBeTruthy();
  });

  it("на отправку вложение уходит С ДАННЫМИ, а не одним именем", async () => {
    render(<Composer />);
    await screen.findByText("приказ №1 (кириллица).pdf");

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));

    await waitFor(() => expect(api.sendEmail).toHaveBeenCalledTimes(1));
    const payload = (api.sendEmail as jest.Mock).mock.calls[0][0] as {
      attachments: Array<{ filename: string; data?: string }>;
    };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("приказ №1 (кириллица).pdf");
    // Главная проверка: если ссылку забудут материализовать, здесь будет undefined —
    // человек видел файл в окне, а письмо ушло бы без него.
    expect(payload.attachments[0].data).toBe("BASE64-ФАЙЛА");
    expect(attachmentBase64).toHaveBeenCalledWith("mail-1", "att-1");
  });

  it("если файл не удалось достать — письмо НЕ отправляется без вложения", async () => {
    (attachmentBase64 as jest.Mock).mockRejectedValue(new Error("файл недоступен"));
    render(<Composer />);
    await screen.findByText("приказ №1 (кириллица).pdf");

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));

    await waitFor(() => expect(screen.getByText(/Не удалось приложить/)).toBeTruthy());
    expect(api.sendEmail).not.toHaveBeenCalled();
  });
});
