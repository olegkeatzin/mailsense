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
  // Личный выбор «почты для СЭД» по умолчанию не сделан: иначе состояние одного теста
  // утекало бы в следующие (jest.clearAllMocks() снимает вызовы, но НЕ подмену значения).
  mockedDocflow.getUserSetting.mockResolvedValue(null);
  mockedDocflow.getExternalAccountState.mockResolvedValue({ explicit: false, accountId: null });
  mockedDocflow.setServiceAccountId.mockResolvedValue("acc-1");
  mockedDocflow.setServiceAccounts.mockResolvedValue({ internal: "acc-1", external: null });
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
    // PUT возвращает тот же shape, что GET, плюс подтверждение записи: перечитывать не нужно.
    expect(res.body).toMatchObject({ ok: true, accountId: "acc-1", incomingAccountId: null });
    expect((res.body as { incoming: Record<string, unknown> }).incoming).toMatchObject({
      configured: false,
      account: null,
      problemCode: "not_configured"
    });
    expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith(
      { internal: "acc-1" },
      expect.objectContaining({ id: "u-admin" })
    );
  });

  test("снять выбор можно явным null", async () => {
    mockedDocflow.setServiceAccounts.mockResolvedValue({ internal: null, external: null });

    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: null }
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accountId: null });
    expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith({ internal: null }, expect.anything());
  });

  test("несуществующий ящик не сохраняется: 400 и ни одной записи", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: "acc-призрак" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_account" });
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
  });

  test("без поля accountId — 400: молча снять выбор нельзя", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_account" });
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
  });

  test("аппарат менять служебный ящик не может — 403", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("secretary"),
      body: { accountId: "acc-1" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
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

  test("accountId вне разрешённых — 403 account_not_allowed, а не молчаливая подмена ящика", async () => {
    // Р24: явно переданный ящик обязан быть в разрешённых (служебный + личный рабочий).
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: { accountId: "acc-призрак" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "account_not_allowed" });
    expect(mockedDocflow.dispatchResolution).not.toHaveBeenCalled();
  });

  test("разрешённый, но исчезнувший ящик — 400 unknown_account", async () => {
    // Ящик выбран в настройках (значит, разрешён), но его уже нет среди ящиков почты:
    // в списке есть другой ящик, поэтому это именно «ящик не найден», а не «ящиков нет».
    mockedCore.listAccounts.mockReturnValue([account({ id: "acc-other", username: "other@mail.test" })]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: { accountId: "acc-1" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_account" });
  });

  test("выбранный личный ящик удалён — 400 account_missing, без подстановки служебного (T58)", async () => {
    mockedDocflow.getUserSetting.mockResolvedValueOnce("acc-удалён");

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "account_missing" });
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
    expect(mockedDocflow.dispatchResolution).not.toHaveBeenCalled();
  });

  test("служебный ящик не задан — отправки нет: «первый подходящий» запрещён (Р24)", async () => {
    mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: false, accountId: null });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "not_configured" });
    expect(mockedCore.sendEmail).not.toHaveBeenCalled();
    expect(String((res.body as { error: string }).error)).toContain("не выбран");
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

describe("две служебные почты: внешняя приёмная и внутренняя (T25)", () => {
  const externalAccount = (patch: Record<string, unknown> = {}) =>
    account({ id: "acc-ext", username: "manufactory@kaluga.net", ...patch });

  beforeEach(() => {
    mockedCore.listAccounts.mockReturnValue([account(), externalAccount()]);
  });

  test("GET отдаёт ОБЕ роли, а прежние поля остаются про внутреннюю (совместимость)", async () => {
    mockedDocflow.getExternalAccountState.mockResolvedValue({ explicit: true, accountId: "acc-ext" });

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", { token: token("secretary") });

    expect(res.status).toBe(200);
    // Прежний контракт: accountId здесь — ВНУТРЕННЯЯ почта, старый клиент продолжает работать.
    expect(res.body).toMatchObject({
      configured: true,
      account: { accountId: "acc-1", username: "test@mail.test" },
      problem: null,
      problemCode: "ok",
      sameAccount: false,
      notice: null
    });
    // Новая роль — отдельным блоком, с теми же полями.
    expect((res.body as { incoming: Record<string, unknown> }).incoming).toMatchObject({
      configured: true,
      account: { accountId: "acc-ext", username: "manufactory@kaluga.net" },
      problem: null,
      problemCode: "ok"
    });
    // И на сервер уходит ровно одна, внешняя, роль — внутренняя не подменяется.
    expect(mockedDocflow.getExternalAccountState).toHaveBeenCalledTimes(1);
  });

  test("одна и та же почта на обеих ролях: разрешено, но с предупреждением", async () => {
    mockedDocflow.getExternalAccountState.mockResolvedValue({ explicit: true, accountId: "acc-1" });

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", { token: token("secretary") });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sameAccount: true });
    expect(String((res.body as { notice: string }).notice)).toContain("один и тот же");
  });

  test("внешняя роль не задана — своя честная подсказка, внутренняя при этом работает", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", { token: token("secretary") });

    expect(res.body).toMatchObject({ configured: true, problemCode: "ok" });
    expect((res.body as { incoming: Record<string, unknown> }).incoming).toMatchObject({
      configured: false,
      account: null,
      problemCode: "not_configured"
    });
  });

  test("старый клиент: PUT {accountId} меняет ТОЛЬКО внутреннюю роль", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: "acc-1" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith({ internal: "acc-1" }, expect.anything());
    expect(res.body).toMatchObject({ ok: true, accountId: "acc-1" });
  });

  test("PUT {incomingAccountId} меняет ТОЛЬКО внешнюю роль", async () => {
    mockedDocflow.setServiceAccounts.mockResolvedValue({ internal: "acc-1", external: "acc-ext" });

    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { incomingAccountId: "acc-ext" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith({ external: "acc-ext" }, expect.anything());
    expect(res.body).toMatchObject({ ok: true, incomingAccountId: "acc-ext" });
  });

  test("PUT с обеими ролями — одна операция, обе сохраняются", async () => {
    mockedDocflow.setServiceAccounts.mockResolvedValue({ internal: "acc-1", external: "acc-ext" });

    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { accountId: "acc-1", incomingAccountId: "acc-ext" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setServiceAccounts).toHaveBeenCalledWith(
      { internal: "acc-1", external: "acc-ext" },
      expect.anything()
    );
  });

  test("несуществующая внешняя почта — 400, ничего не записано", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: { incomingAccountId: "acc-призрак" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_account" });
    expect(String((res.body as { error: string }).error)).toContain("Внешн");
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
  });

  test("внешняя приёмная без SMTP остаётся рабочей ролью (приём, не отправка)", async () => {
    mockedDocflow.getExternalAccountState.mockResolvedValue({ explicit: true, accountId: "acc-ext" });
    mockedCore.listAccounts.mockReturnValue([account(), externalAccount({ smtpHost: null })]);

    const res = await request(app.baseUrl, "GET", "/api/docflow/service-account", { token: token("secretary") });

    expect(res.status).toBe(200);
    expect((res.body as { incoming: Record<string, unknown> }).incoming).toMatchObject({
      configured: true,
      problem: null,
      problemCode: "ok"
    });
    // И при этом видно, что отправлять с неё нечем — как справка, а не как ошибка выбора.
    expect(
      (res.body as { incoming: { account: { smtpConfigured: boolean } } }).incoming.account.smtpConfigured
    ).toBe(false);
  });

  test("PUT без обеих ролей — 400: молча ничего не снимаем", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("admin"),
      body: {}
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_account" });
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
  });

  test("исполнитель не может менять ни одну из ролей — 403", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/service-account", {
      token: token("executor"),
      body: { incomingAccountId: "acc-ext" }
    });

    expect(res.status).toBe(403);
    expect(mockedDocflow.setServiceAccounts).not.toHaveBeenCalled();
  });

  test("пересылка руководителю всегда с ВНУТРЕННЕЙ почты, внешняя роль на неё не влияет", async () => {
    // Внешняя роль указывает на ящик без SMTP: если бы отправка брала её, был бы 400.
    mockedDocflow.getExternalAccountState.mockResolvedValue({ explicit: true, accountId: "acc-ext" });
    mockedCore.listAccounts.mockReturnValue([
      account({ id: "acc-1", username: "test@mail.test" }),
      externalAccount({ smtpHost: null })
    ]);
    mockedDocflow.getUser.mockResolvedValue({ id: "u-manager", fullName: "Руководитель", email: "m@stand.test" });
    mockedDocflow.getDocument.mockResolvedValue({ id: "doc-1", regNumber: "вх1", emailId: null });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/forward", {
      token: token("secretary"),
      body: { documentId: "doc-1", toUserId: "u-manager" }
    });

    expect(res.status).toBe(201);
    expect(mockedCore.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-1" }));
  });
});
