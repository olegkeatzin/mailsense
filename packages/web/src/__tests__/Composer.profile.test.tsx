/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => {
  const actual = jest.requireActual("../api") as Record<string, unknown>;
  return {
    ...actual,
    // Сеть подменяем только на границе: сборка вложений остаётся настоящей,
    // иначе отправка падала бы не по теме теста.
    attachmentBase64: jest.fn(),
    api: {
      accounts: jest.fn(),
      emails: jest.fn(),
      templates: jest.fn(),
      composeTemplate: jest.fn(),
      sendEmail: jest.fn(),
      mailProfile: jest.fn(),
      createDraft: jest.fn(),
      updateDraft: jest.fn(),
      deleteDraft: jest.fn(),
      searchContacts: jest.fn()
    }
  };
});

// Редактор в jsdom не нужен, но его содержимое — предмет проверки: показываем HTML как есть.
// Дополнительно редактор ОДИН раз отдаёт наружу свою нормализацию разметки — так ведёт
// себя tiptap, и именно на этом ломалась подстановка подписи в ответе (гонка D12).
jest.mock("../components/RichTextEditor", () => {
  const React = jest.requireActual("react") as typeof import("react");
  return {
    __esModule: true,
    default: ({ value, onChange }: { value: string; onChange: (html: string) => void }) => {
      const echoed = React.useRef(false);
      React.useEffect(() => {
        if (echoed.current) return;
        echoed.current = true;
        onChange(value.replace("<blockquote", '<blockquote class="normalized"'));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="editor-body" dangerouslySetInnerHTML={{ __html: value }} />;
    }
  };
});

import { api } from "../api";
import Composer from "../components/Composer";
import { useStore } from "../store";
import type { Account, ComposeTemplate, EmailView, MailProfile } from "../types";

const initial = useStore.getState();

const template = {
  accountId: "acc-1",
  mode: "new",
  to: [{ address: "user2@mail.test" }],
  cc: [],
  bcc: [],
  subject: "Приказ о поставке",
  bodyText: "",
  bodyHtml: "<p></p>",
  inReplyToEmailId: null,
  inReplyToMessageId: null,
  references: [],
  attachments: []
} as unknown as ComposeTemplate;

const profile: MailProfile = {
  userId: "u-petrova",
  displayName: "Петрова Мария",
  signatureText: "С уважением, Мария Петрова",
  signatureEnabled: true,
  signaturePosition: "below",
  replyQuote: true,
  replyAttribution: "ru",
  updatedAt: null
};

/** Пустой профиль: ничего не подставляем и письмо не ломаем. */
const emptyProfile: MailProfile = {
  userId: "u-petrova",
  displayName: "",
  signatureText: "",
  signatureEnabled: true,
  signaturePosition: "below",
  replyQuote: true,
  replyAttribution: "ru",
  updatedAt: null
};

describe("окно письма: личное имя и личная подпись (T36)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      // У ЯЩИКА своя подпись: она НЕ должна попасть в письмо.
      accounts: [
        { id: "acc-1", username: "user2@mail.test", settings: { signature: "ПОДПИСЬ ЯЩИКА", signatureEnabled: true } } as unknown as Account
      ],
      accountFilter: "acc-1",
      emailView: null,
      compose: { open: true, mode: "new", emailId: null, draft: null }
    });
    (api.composeTemplate as jest.Mock).mockResolvedValue(template);
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.sendEmail as jest.Mock).mockResolvedValue({ emailId: "sent-1", messageId: "<m@test>" });
    (api.mailProfile as jest.Mock).mockResolvedValue(profile);
  });

  it("шаблон запрашивается без подписи ящика (useAccountSignature=false)", async () => {
    render(<Composer />);

    await waitFor(() => expect(api.composeTemplate).toHaveBeenCalledTimes(1));
    expect(api.composeTemplate).toHaveBeenCalledWith("acc-1", "new", null, { useAccountSignature: false });
  });

  it("в тело письма попадает ЛИЧНАЯ подпись, а подписи ящика там нет", async () => {
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    await waitFor(() => expect(editor.textContent).toContain("Мария Петрова"));
    expect(editor.textContent).not.toContain("ПОДПИСЬ ЯЩИКА");
  });

  it("отправка несёт fromName из личного профиля; у нового письма replyTo нет", async () => {
    render(<Composer />);
    await screen.findByTestId("editor-body");
    await waitFor(() => expect(api.mailProfile).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));

    await waitFor(() => expect(api.sendEmail).toHaveBeenCalledTimes(1));
    const payload = (api.sendEmail as jest.Mock).mock.calls[0][0] as { fromName?: string; replyTo?: string };
    expect(payload.fromName).toBe("Петрова Мария");
    expect(payload.replyTo).toBeUndefined();
  });

  it("пустой профиль: подписи нет и fromName не выдумывается", async () => {
    (api.mailProfile as jest.Mock).mockResolvedValue(emptyProfile);
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    expect(editor.textContent ?? "").not.toContain("Мария Петрова");
    expect(editor.textContent ?? "").not.toContain("mailsense-signature");

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));
    await waitFor(() => expect(api.sendEmail).toHaveBeenCalledTimes(1));
    expect((api.sendEmail as jest.Mock).mock.calls[0][0].fromName).toBeUndefined();
  });
});

describe("отправка доступна без прав роли: граница — владелец ящика", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      accounts: [{ id: "acc-1", username: "user2@mail.test", settings: {} } as unknown as Account],
      accountFilter: "acc-1",
      emailView: null,
      compose: { open: true, mode: "new", emailId: null, draft: null },
      docflowUnavailable: false,
      authStatus: { docflowEnabled: true } as never,
      // Ролей почты больше нет: работник отправляет со СВОЕГО ящика.
      authUser: { permissions: [], roles: ["executor"], fullName: "Мария Петрова" } as never
    });
    (api.composeTemplate as jest.Mock).mockResolvedValue(template);
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.sendEmail as jest.Mock).mockResolvedValue({ emailId: "sent-1", messageId: "<m@test>" });
    (api.mailProfile as jest.Mock).mockResolvedValue(profile);
  });

  it("без ролей кнопка «Отправить» не заблокирована правами", async () => {
    render(<Composer />);
    await screen.findByTestId("editor-body");

    const sendButton = screen.getByRole("button", { name: /Отправить/ }) as HTMLButtonElement;
    // ⚠️ Раньше кнопка была выключена без mail.send. Теперь прав на почту нет: причина
    // блокировки может быть только в самом письме (пустые поля), но не в правах.
    expect(sendButton.getAttribute("title")).not.toBe("Недостаточно прав для отправки");
    expect(useStore.getState().canSendMail()).toBe(true);
  });
});

describe("ответ: подпись ставится ПОСЛЕ сборки тела с цитатой (D12)", () => {
  beforeAll(installDomEnvironment);

  const quoteTemplate = {
    ...template,
    mode: "reply",
    inReplyToEmailId: "mail-1",
    subject: "Re: Вопрос",
    bodyHtml:
      '<p></p><p class="mailsense-attribution">Клиент пишет:</p>' +
      '<blockquote style="border-left:2px solid #d0d0d0">оригинал письма</blockquote>'
  } as unknown as ComposeTemplate;

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      accounts: [
        { id: "acc-1", username: "intake@mail.test", settings: { signature: "ПОДПИСЬ ЯЩИКА" } } as unknown as Account
      ],
      accountFilter: "acc-1",
      emailView: {
        id: "mail-1",
        accountId: "acc-1",
        subject: "Вопрос",
        bodyText: "оригинал письма",
        bodyHtml: "<p>оригинал письма</p>",
        from: { address: "client@outside.test" },
        replyTo: [],
        to: [],
        cc: [],
        references: [],
        attachments: [],
        analysis: null
      } as unknown as EmailView,
      compose: { open: true, mode: "reply", emailId: "mail-1", draft: null }
    });
    (api.composeTemplate as jest.Mock).mockResolvedValue(quoteTemplate);
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.mailProfile as jest.Mock).mockResolvedValue(profile);
  });

  it("в ответе есть и цитата, и личная подпись, причём подпись ПОСЛЕ цитаты", async () => {
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    await waitFor(() => expect(editor.innerHTML).toContain("mailsense-signature"));
    expect(editor.textContent).toContain("Мария Петрова");
    expect(editor.innerHTML).toContain("<blockquote");
    expect(editor.innerHTML.indexOf("mailsense-signature")).toBeGreaterThan(editor.innerHTML.indexOf("</blockquote>"));
    expect(editor.innerHTML).not.toContain("ПОДПИСЬ ЯЩИКА");
  });

  it("положение «до цитаты» ставит подпись ПЕРЕД цитатой", async () => {
    (api.mailProfile as jest.Mock).mockResolvedValue({ ...profile, signaturePosition: "above" });
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    await waitFor(() => expect(editor.innerHTML).toContain("mailsense-signature"));
    expect(editor.innerHTML.indexOf("mailsense-signature")).toBeLessThan(editor.innerHTML.indexOf("<blockquote"));
  });

  it("выключенная цитата: её нет, а подпись остаётся", async () => {
    (api.mailProfile as jest.Mock).mockResolvedValue({ ...profile, replyQuote: false });
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    await waitFor(() => expect(editor.innerHTML).toContain("mailsense-signature"));
    expect(editor.innerHTML).not.toContain("<blockquote");
  });

  it("профиль без подписи: ни подписи, ни цитаты (при выключенной цитате)", async () => {
    (api.mailProfile as jest.Mock).mockResolvedValue({ ...emptyProfile, replyQuote: false });
    render(<Composer />);

    const editor = await screen.findByTestId("editor-body");
    await waitFor(() => expect(editor.innerHTML).not.toContain("<blockquote"));
    expect(editor.innerHTML).not.toContain("mailsense-signature");
  });
});

describe("ответ: ящик из письма и replyTo (Р19)", () => {
  beforeAll(installDomEnvironment);

  const replyTemplate = {
    ...template,
    accountId: "acc-intake",
    mode: "reply",
    inReplyToEmailId: "mail-1",
    bodyHtml: "<p></p>"
  } as unknown as ComposeTemplate;

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState({
      ...initial,
      accounts: [
        // Внешняя приёмная — туда пришло письмо; внутренняя выбрана в списке.
        { id: "acc-intake", username: "intake@mail.test", settings: { signature: "ПОДПИСЬ ЯЩИКА" } } as unknown as Account,
        { id: "acc-inner", username: "post@mail.test", settings: { signature: "ПОДПИСЬ ЯЩИКА" } } as unknown as Account
      ],
      accountFilter: "acc-inner",
      // EmailView расширяет Email: accountId письма лежит на верхнем уровне.
      emailView: {
        id: "mail-1",
        accountId: "acc-intake",
        subject: "Вопрос",
        bodyText: "текст",
        bodyHtml: "<p>текст</p>",
        from: { address: "client@outside.test" },
        replyTo: [],
        to: [],
        cc: [],
        references: [],
        attachments: [],
        analysis: null
      } as unknown as EmailView,
      compose: { open: true, mode: "reply", emailId: "mail-1", draft: null }
    });
    (api.composeTemplate as jest.Mock).mockResolvedValue(replyTemplate);
    (api.templates as jest.Mock).mockResolvedValue([]);
    (api.emails as jest.Mock).mockResolvedValue([]);
    (api.sendEmail as jest.Mock).mockResolvedValue({ emailId: "sent-2", messageId: "<m2@test>" });
    (api.mailProfile as jest.Mock).mockResolvedValue(profile);
  });

  it("шаблон ответа берётся у ящика ПИСЬМА, а не у выбранного в списке", async () => {
    render(<Composer />);

    await waitFor(() => expect(api.composeTemplate).toHaveBeenCalledTimes(1));
    expect(api.composeTemplate).toHaveBeenCalledWith("acc-intake", "reply", "mail-1", { useAccountSignature: false });
  });

  it("ответ уходит с личным именем и replyTo = адрес ящика, куда пришло письмо", async () => {
    render(<Composer />);
    await screen.findByTestId("editor-body");
    await waitFor(() => expect(api.mailProfile).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Отправить/ }));

    await waitFor(() => expect(api.sendEmail).toHaveBeenCalledTimes(1));
    const payload = (api.sendEmail as jest.Mock).mock.calls[0][0] as { fromName?: string; replyTo?: string };
    expect(payload.replyTo).toBe("intake@mail.test");
    expect(payload.fromName).toBe("Петрова Мария");
  });
});
