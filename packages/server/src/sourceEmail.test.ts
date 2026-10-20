import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Письмо-источник по задаче (T41).
 *
 * Прав на почту у ролей нет, но исполнитель должен видеть,
 * ЧТО исполняет. Маршрут отдаёт письмо через документооборот и только участнику ЭТОГО
 * поручения; чужая задача → 403, письмо без связи → 404, служебные поля ящика не утекают.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const TOKENS = {
  executor: "token:executor",
  signer: "token:signer",
  secretary: "token:secretary",
  partner: "token:partner"
};

const OURS = "res-1";
const FOREIGN = "res-2";

function detail(patch: Record<string, unknown> = {}) {
  return {
    id: OURS,
    documentId: "doc-1",
    documentNumber: "вх1",
    text: "Подготовить ответ",
    documentEmailId: "mail-1",
    status: "sent",
    preparedBy: "u-secretary",
    approvedBy: "u-signer",
    confirmedBy: null,
    dispatchedBy: "u-secretary",
    assignees: [{ userId: "u-executor", fullName: "Петрова М.А.", kind: "responsible" }],
    ...patch
  };
}

let app: RunningApp;
let attachmentFile = "";
const ATTACHMENT_TEXT = "СОДЕРЖИМОЕ ВЛОЖЕНИЯ ПИСЬМА-ИСТОЧНИКА";

beforeAll(async () => {
  attachmentFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-src-")), "письмо.txt");
  fs.writeFileSync(attachmentFile, ATTACHMENT_TEXT, "utf8");

  mockedDocflow.__sessions.set(TOKENS.executor, testUser("u-executor", ["executor"]));
  mockedDocflow.__sessions.set(TOKENS.signer, testUser("u-signer", ["signer"]));
  mockedDocflow.__sessions.set(TOKENS.secretary, testUser("u-secretary", ["secretary"]));
  mockedDocflow.__sessions.set(TOKENS.partner, testUser("u-partner", []));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(path.dirname(attachmentFile), { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // Письмо-источник: в ответе не должно быть ни одного служебного поля ящика.
  mockedCore.getEmailView.mockReturnValue({
    id: "mail-1",
    accountId: "acc-secret",
    folder: "INBOX",
    uid: "42",
    messageId: "vh1@mail.test",
    subject: "Входящее письмо от контрагента",
    from: { address: "client@mail.test", name: "Контрагент" },
    to: [{ address: "test@mail.test", name: "Аппарат" }],
    cc: [],
    date: "2026-10-01T10:00:00.000Z",
    bodyText: "Просим подготовить ответ.",
    bodyHtml: null
  });
  mockedCore.listAttachments.mockReturnValue([
    {
      id: "att-1",
      emailId: "mail-1",
      filename: "письмо.txt",
      mimeType: "text/plain",
      size: Buffer.byteLength(ATTACHMENT_TEXT),
      storagePath: attachmentFile
    }
  ]);
  mockedDocflow.getResolutionDetail.mockImplementation(async (id: string) => {
    if (id === OURS) return detail();
    if (id === FOREIGN) return detail({ id: FOREIGN, assignees: [{ userId: "u-other", fullName: "Другой", kind: "responsible" }] });
    return null;
  });
});

describe("письмо-источник своей задачи доступно исполнителю", () => {
  it("исполнитель своей задачи видит письмо", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      resolutionId: OURS,
      emailId: "mail-1",
      subject: "Входящее письмо от контрагента",
      bodyText: "Просим подготовить ответ.",
      from: { address: "client@mail.test" },
      attachments: [{ id: "att-1", filename: "письмо.txt", mimeType: "text/plain" }]
    });
  });

  /**
   * ownEmailId — копия письма о ПОРУЧЕНИИ в ящике работника. По ней из «Моих задач»
   * открывается настоящее письмо. Пока поручение не отправлено — копии нет, и это
   * законный null, а не ошибка.
   */
  it("без отправленного поручения ownEmailId пустой", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ownEmailId", null);
  });

  it("служебные поля ящика наружу НЕ уходят", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    for (const secret of ["acc-secret", "accountId", "storagePath", "INBOX", "\"uid\"", "\"folder\""]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("подписант, утвердивший поручение, тоже видит письмо", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.signer });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: "Входящее письмо от контрагента" });
  });

  it("аппарат, готовивший поручение, видит письмо", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.secretary });

    expect(res.status).toBe(200);
  });
});

describe("чужая задача и чужая связь закрыты", () => {
  it("исполнитель на чужое поручение → 403, и отказ попадает в след", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + FOREIGN + "/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(403);
    expect(mockedDocflow.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resolution.source_email_denied", entityId: FOREIGN, userId: "u-executor" })
    );
    // Письмо чужой задачи не читается вообще.
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
  });

  it("несуществующее поручение → 404", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/нет-такого/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(404);
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
  });

  it("поручение без письма-источника → 404 (а не пустое письмо)", async () => {
    mockedDocflow.getResolutionDetail.mockResolvedValueOnce(detail({ documentEmailId: null }));

    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.executor });

    expect(res.status).toBe(404);
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
  });

  it("пользователь без права task.view → 403", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email", { token: TOKENS.partner });

    expect(res.status).toBe(403);
    expect(mockedCore.getEmailView).not.toHaveBeenCalled();
  });

  it("без сессии → 401", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email");

    expect(res.status).toBe(401);
  });
});

describe("вложение письма-источника", () => {
  it("исполнитель своей задачи скачивает вложение: байты совпадают", async () => {
    const res = await fetch(app.baseUrl + "/api/docflow/tasks/" + OURS + "/source-email/attachments/att-1", {
      headers: { authorization: "Bearer " + TOKENS.executor }
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ATTACHMENT_TEXT);
  });

  it("вложение чужой задачи → 403", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + FOREIGN + "/source-email/attachments/att-1", { token: TOKENS.executor });

    expect(res.status).toBe(403);
  });

  it("чужой идентификатор вложения из этого письма не отдаётся → 404", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/tasks/" + OURS + "/source-email/attachments/чужое", { token: TOKENS.executor });

    expect(res.status).toBe(404);
  });
});
