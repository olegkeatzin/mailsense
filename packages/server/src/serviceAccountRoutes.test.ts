import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Служебный ящик отправки (Р12, task-11).
 *
 * Проверяем снаружи: аппарат видит параметры ящика (и НЕ видит пароль), выбор ящика
 * сохраняется с аудитом, а отправка объясняет отказ словами вместо падения SMTP.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, unknown>;
};

const token = (role: string) => "token:" + role;

const account = (patch: Record<string, unknown> = {}) => ({
  id: "acc-1",
  protocol: "imap",
  host: "mail.test",
  port: 993,
  tls: "ssl",
  username: "test@mail.test",
  passwordEncrypted: "ШИФР-ПАРОЛЬ-НЕ-ОТДАВАТЬ",
  authType: "password",
  settings: {},
  smtpHost: "mail.test",
  smtpPort: 465,
  smtpTls: "ssl",
  smtpUsername: "test@mail.test",
  smtpPasswordEncrypted: "ШИФР-SMTP-НЕ-ОТДАВАТЬ",
  smtpAuthType: "password",
  ...patch
});

let expressApp: express.Express;
let app: RunningApp;

beforeAll(async () => {
  for (const role of ["admin", "secretary", "manager", "signer", "executor", "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  expressApp = await createApp({});
  app = await listen(expressApp);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedCore.listAccounts.mockReturnValue([account()]);
  mockedCore.getSettingValue.mockReturnValue(null);
  mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-1" });
  mockedDocflow.setServiceAccountId.mockResolvedValue("acc-1");
  mockedDocflow.getDocument.mockResolvedValue({ id: "doc-1", regNumber: "вх1", emailId: null });
  mockedDocflow.getResolutionDetail.mockResolvedValue({
    id: "res-1",
    documentId: "doc-1",
    documentNumber: "вх1",
    text: "Подготовить ответ",
    deadline: null,
    status: "approved",
    preparedBy: null,
    approvedBy: null,
    confirmedBy: null,
    dispatchedBy: null,
    assignees: [{ userId: "u-executor", fullName: "Исполнитель", email: "e@stand.test", kind: "responsible" }]
  });
});

describe("подсказка аппарату: параметры служебного ящика", () => {
  test("аппарат видит хост, порт, tls и логин — но ни одного пароля", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      account: {
        accountId: "acc-1",
        username: "test@mail.test",
        protocol: "imap",
        host: "mail.test",
        port: 993,
        tls: "ssl",
        smtpConfigured: true
      },
      problem: null,
      problemCode: "ok",
      problemCode: "ok"
    });
    // Секреты не покидают сервер даже в виде шифротекста.
    expect(res.text).not.toContain("ШИФР-ПАРОЛЬ-НЕ-ОТДАВАТЬ");
    expect(res.text).not.toContain("ШИФР-SMTP-НЕ-ОТДАВАТЬ");
    expect(res.text).not.toContain("passwordEncrypted");
    expect(res.text).not.toContain("smtpPasswordEncrypted");
  });

  test("рядовой исполнитель параметров ящика не видит — 403", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", {
      token: token("executor")
    });
    expect(res.status).toBe(403);
  });

  test("ящик не задан: честный ответ и предупреждение в лог, а не тишина", async () => {
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: null });

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, account: null, problemCode: "not_configured" });
    expect(String((res.body as { problem: string }).problem).toLowerCase()).toContain("не задан");
    expect(mockedCore.logger.warn).toHaveBeenCalled();
  });

  test("ящик задан, но его больше нет: сказано прямо", async () => {
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-удалён" });

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", {
      token: token("secretary")
    });

    expect(res.body).toMatchObject({ configured: true, account: null, problemCode: "account_missing" });
    expect(String((res.body as { problem: string }).problem)).toContain("не существует");
  });

  test("у ящика нет SMTP: параметры видны, но problem объясняет, что отправлять нечем", async () => {
    mockedCore.listAccounts.mockReturnValue([account({ smtpHost: null })]);

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", {
      token: token("secretary")
    });

    expect(res.status).toBe(200);
    expect((res.body as { account: { smtpConfigured: boolean } }).account.smtpConfigured).toBe(false);
    expect(String((res.body as { problem: string }).problem)).toContain("SMTP");
  });
});

describe("выбор служебного ящика сохраняется с аудитом", () => {
  test("администратор задаёт ящик — значение уходит в docflow с актором", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: "acc-1" }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accountId: "acc-1" });
    expect(mockedDocflow.setServiceAccountId).toHaveBeenCalledWith("acc-1", expect.objectContaining({ id: "u-admin" }));
  });

  test("снять выбор можно явным null", async () => {
    mockedDocflow.setServiceAccountId.mockResolvedValue(null);

    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: null }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accountId: null });
    expect(mockedDocflow.setServiceAccountId).toHaveBeenCalledWith(null, expect.anything());
  });

  test("несуществующий ящик не сохраняется: 400 и ни одной записи", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: "acc-призрак" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_account" });
    expect(mockedDocflow.setServiceAccountId).not.toHaveBeenCalled();
  });

  test("без поля accountId — 400: молча снять выбор нельзя", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_account" });
    expect(mockedDocflow.setServiceAccountId).not.toHaveBeenCalled();
  });

  test("аппарат менять служебный ящик не может — 403", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("secretary"),
      body: { accountId: "acc-1" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.setServiceAccountId).not.toHaveBeenCalled();
  });
});

describe("отправка поручения использует служебный ящик и объясняет отказ", () => {
  test("у служебного ящика нет SMTP — 400 с текстом, и поручение НЕ помечается отправленным", async () => {
    mockedCore.listAccounts.mockReturnValue([account({ smtpHost: null })]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "smtp_not_configured" });
    expect(String((res.body as { error: string }).error)).toContain("SMTP");
    // Проверяем ДО перехода: иначе поручение осталось бы «отправлено» без письма.
    expect(mockedDocflow.dispatchResolution).not.toHaveBeenCalled();
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
  });

  test("несуществующий accountId в теле — 400, а не молчаливая подмена ящика", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: { accountId: "acc-призрак" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_account" });
    expect(mockedDocflow.dispatchResolution).not.toHaveBeenCalled();
  });

  test("служебный ящик не задан — работаем, но предупреждаем в лог", async () => {
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: false, accountId: null });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(200);
    expect(mockedCore.sendEmail).toHaveBeenCalled();
    expect(mockedCore.logger.warn).toHaveBeenCalled();
  });

  test("СТАРЫЙ КЛЮЧ настроек почты ИГНОРИРУЕТСЯ: он больше не влияет на выбор ящика", async () => {
    // Раньше значение из настроек ПОЧТЫ (docflow.serviceAccountId) подставлялось как запасное,
    // и «снять служебный ящик» не отключало отправку — дефект, пойманный живой проверкой.
    // Теперь единственный источник — настройки СЭД; старый ключ не читается вообще.
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: false, accountId: null });
    mockedCore.getSettingValue.mockImplementation((key: string) =>
      key === "docflow.serviceAccountId" ? "acc-1" : null
    );
    // Два готовых ящика: выбор неоднозначен, значит отправки быть не должно.
    mockedCore.listAccounts.mockReturnValue([
      account({ id: "acc-legacy", username: "post@mail.test" }),
      account({ id: "acc-other", username: "other@mail.test" })
    ]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "not_configured" });
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
    expect(mockedDocflow.forwardToManager).not.toHaveBeenCalled();

    // Ни выбор ящика, ни подсказка аппарату не смотрят в старое место.
    expect(mockedCore.getSettingValue).not.toHaveBeenCalledWith("docflow.serviceAccountId");
    const hint = await request(app.baseUrl, "GET", "/api/docflow/service-account", { token: token("secretary") });
    expect(hint.body).toMatchObject({ configured: false, account: null, problemCode: "not_configured" });
  });

  test("письмо руководителю: ящиков нет вовсе — понятная ошибка вместо падения", async () => {
    mockedCore.listAccounts.mockReturnValue([]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "no_account" });
    expect(mockedDocflow.forwardToManager).not.toHaveBeenCalled();
  });

  test("письмо руководителю уходит со служебного ящика, а не с первого попавшегося", async () => {
    // Первым в списке — ящик директора без SMTP: раньше именно он и выбирался.
    mockedCore.listAccounts.mockReturnValue([
      account({ id: "acc-dir", username: "user2@mail.test", smtpHost: null }),
      account({ id: "acc-post", username: "post@mail.test" })
    ]);
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-post" });
    mockedDocflow.getUser.mockResolvedValue({
      id: "u-manager",
      fullName: "Руководитель",
      email: "manager@stand.test"
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(201);
    expect(mockedCore.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-post" })
    );
  });
});
