/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

jest.mock("../api", () => {
  const actual = jest.requireActual("../api") as Record<string, unknown> & {
    api: Record<string, unknown>;
    resolutionApi: Record<string, unknown>;
  };
  return {
    ...actual,
    attachmentBase64: jest.fn(),
    api: {
      ...actual.api,
      accounts: jest.fn().mockResolvedValue([]),
      templates: jest.fn().mockResolvedValue([]),
      drafts: jest.fn().mockResolvedValue([]),
      mailProfile: jest.fn().mockResolvedValue({
        userId: "u-1",
        displayName: "",
        signatureText: "",
        signatureEnabled: false,
        signaturePosition: "below",
        replyQuote: true,
        replyAttribution: "ru",
        updatedAt: null
      }),
      sendEmail: jest.fn().mockResolvedValue({ emailId: "sent-1", messageId: "<m@test>" }),
      createDraft: jest.fn(),
      updateDraft: jest.fn(),
      createTemplate: jest.fn(),
      searchContacts: jest.fn().mockResolvedValue([])
    },
    resolutionApi: {
      ...actual.resolutionApi,
      forward: jest.fn().mockResolvedValue({ id: "res-1" })
    }
  };
});

jest.mock("../components/RichTextEditor", () => ({ __esModule: true, default: () => null }));

import { resolutionApi } from "../api";
import Composer from "../components/Composer";
import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";

/**
 * Письмо руководителю из окна правки: в «Кому» адрес показан как «Имя <a@b>»,
 * а серверу связи нужен чистый a@b. Раньше туда уходила строка с угловыми скобками,
 * и письмо уходило, а поручение не связывалось (bad_email).
 */
const initial = useStore.getState();

beforeAll(installDomEnvironment);

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    ...initial,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: ["resolution.dispatch"], roles: ["secretary"] } as unknown as AuthUser,
    accounts: [{ id: "acc-1", username: "post@mail.test", settings: {} } as never],
    accountFilter: null,
    compose: {
      open: true,
      mode: "new",
      emailId: null,
      draft: null,
      edms: {
        documentId: "doc-1",
        subject: "Письмо вх1 — прошу наложить резолюцию",
        bodyText: "Добрый день!",
        to: [{ address: "p@mail.test", name: "Мария Петрова" }],
        toEmail: "p@mail.test",
        toUserId: "u-signer"
      }
    }
  });
});

afterEach(() => {
  useStore.getState().closeCompose();
});

it("связывает письмо с поручением по чистому адресу, а не по «Имя <адрес>»", async () => {
  render(<Composer />);

  fireEvent.click(await screen.findByRole("button", { name: /Отправить/ }));

  await waitFor(() =>
    expect(resolutionApi.forward).toHaveBeenCalledWith("doc-1", "u-signer", undefined, {
      emailId: "sent-1",
      toEmail: "p@mail.test"
    })
  );
});
