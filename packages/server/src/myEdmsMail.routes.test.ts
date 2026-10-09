import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { createApp } from "./app.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * «Почта для СЭД»: личный выбор работника (Р24, task-51).
 *
 * Проверяем правило отправки и ГЛАВНОЕ свойство доступа: работник видит и меняет
 * только СВОЙ выбор — идентификатор берётся из сессии, а не из тела запроса.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const READY = {
  id: "acc-personal",
  username: "ivanov@mail.test",
  host: "mail.test",
  protocol: "imap",
  port: 993,
  tls: "ssl",
  authType: "password",
  passwordEncrypted: "ШИФР",
  smtpHost: "mail.test",
  smtpPort: 465,
  smtpTls: "ssl",
  smtpUsername: "ivanov@mail.test",
  smtpPasswordEncrypted: "ШИФР"
};
const SERVICE = { ...READY, id: "acc-service", username: "post@mail.test" };
/** Готовый к отправке, но НЕ выданный ящик: например, директора или коллеги. */
const FOREIGN = { ...READY, id: "acc-foreign", username: "director@mail.test" };
/** Выданный ящик БЕЗ SMTP: почта только входящая (ровно случай Петровой на стенде, дефект T58). */
const NO_SMTP = {
  ...READY,
  id: "acc-nosmtp",
  username: "petrova_ma@mail.test",
  smtpHost: null,
  smtpPort: null,
  smtpTls: null,
  smtpUsername: null,
  smtpPasswordEncrypted: null
};
const TOKEN = "token:secretary";
/** Работник, чей адрес из каталога совпадает с адресом ящика: выдача ему не нужна. */
const TOKEN_SELF = "token:self";
let app: RunningApp;
/** «База» личных настроек в тесте: заглушка хранит выбор, как настоящая таблица. */
let stored: string | null = null;

beforeAll(async () => {
  mockedDocflow.__sessions.set(TOKEN, testUser("u-ivanov", ["secretary"], { ldapUid: "ivanov" }));
  mockedDocflow.__sessions.set(
    TOKEN_SELF,
    testUser("u-self", ["secretary"], { ldapUid: "self", email: "ivanov@mail.test" })
  );
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  stored = null;
  mockedCore.listAccounts.mockReturnValue([SERVICE, READY, FOREIGN, NO_SMTP]);
  mockedDocflow.getAllowedWorkAccounts.mockResolvedValue([]);
  mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-service" });
  // Чтение и запись связаны: ответ PUT обязан показать уже сохранённый выбор.
  mockedDocflow.getUserSetting.mockImplementation(async () => stored);
  mockedDocflow.setUserSetting.mockImplementation(async (_userId: string, _key: string, value: string | null) => {
    stored = value;
    return value;
  });
});

describe("GET /api/docflow/my-edms-mail", () => {
  test("выбора нет: пусто, а разрешён только служебный ящик", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountId: null,
      account: null,
      allowed: [{ id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: true, kind: "service" }],
      defaultAccountId: "acc-service"
    });
  });

  test("выданный ящик разрешён: он в списке и выбирается по умолчанию", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-personal"]);
    mockedDocflow.getUserSetting.mockResolvedValue("acc-personal");

    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accountId: "acc-personal",
      account: { id: "acc-personal", username: "ivanov@mail.test", host: "mail.test", smtpReady: true },
      defaultAccountId: "acc-personal"
    });
    // Порядок постановки: сначала служебный ящик предприятия, затем личные варианты.
    expect((res.body as { allowed: Array<{ kind: string }> }).allowed.map((a) => a.kind)).toEqual([
      "service",
      "personal"
    ]);
  });

  test("чужой ящик не попадает в список, даже если он готов к отправке", async () => {
    // Выдачи нет: в списке только служебный ящик предприятия.
    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN });

    expect(res.status).toBe(200);
    expect((res.body as { allowed: Array<{ id: string }> }).allowed.map((a) => a.id)).toEqual(["acc-service"]);
  });

  test("выданный ящик БЕЗ SMTP виден работнику с честным флагом (дефект T58)", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-nosmtp"]);

    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN });

    expect(res.status).toBe(200);
    // Выдача администратора не должна «исчезать»: работник видит ящик и понимает, почему
    // отправка с него не пойдёт (интерфейс пишет это по smtpReady).
    expect((res.body as { allowed: Array<{ id: string; smtpReady: boolean; kind: string }> }).allowed).toEqual([
      { id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: true, kind: "service" },
      { id: "acc-nosmtp", username: "petrova_ma@mail.test", host: "mail.test", smtpReady: false, kind: "personal" }
    ]);
  });

  test("выданный ящик БЕЗ SMTP можно выбрать — отказ будет на отправке", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-nosmtp"]);

    const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
      token: TOKEN,
      body: { accountId: "acc-nosmtp" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setUserSetting).toHaveBeenCalledWith(
      "u-ivanov",
      "edms.workAccountId",
      "acc-nosmtp",
      expect.anything(),
      "edms.work_mail"
    );
  });

  test("выбранный ящик удалили: выбор виден, а ящика в списке нет (T58)", async () => {
    // Ящика нет среди почты (его удалили), но выбор работника остался — интерфейс должен
    // сказать «выбранный ящик больше не существует, выберите другой», а не подставлять служебный.
    mockedDocflow.getUserSetting.mockResolvedValue("acc-удалён");

    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId: "acc-удалён", account: null, defaultAccountId: null });
    expect((res.body as { allowed: Array<{ id: string }> }).allowed.map((a) => a.id)).toEqual(["acc-service"]);
  });

  test("свой ящик разрешён без выдачи: адрес из каталога совпал с адресом ящика", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail", { token: TOKEN_SELF });

    expect(res.status).toBe(200);
    expect((res.body as { allowed: Array<{ id: string; kind: string }> }).allowed).toEqual([
      { id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: true, kind: "service" },
      { id: "acc-personal", username: "ivanov@mail.test", host: "mail.test", smtpReady: true, kind: "personal" }
    ]);
  });

  test("без входа — 401", async () => {
    const res = await request(app.baseUrl, "GET", "/api/docflow/my-edms-mail");

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/docflow/my-edms-mail", () => {
  test("выбор сохраняется и возвращается тем же shape, что GET", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-personal"]);
    const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
      token: TOKEN,
      body: { accountId: "acc-personal" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setUserSetting).toHaveBeenCalledWith(
      "u-ivanov",
      "edms.workAccountId",
      "acc-personal",
      expect.objectContaining({ id: "u-ivanov" }),
      "edms.work_mail"
    );
    expect(res.body).toMatchObject({ accountId: "acc-personal" });
    expect((res.body as { allowed: unknown[] }).allowed).toHaveLength(2);
  });

  test("снятие выбора: null очищает настройку", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
      token: TOKEN,
      body: { accountId: null }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setUserSetting).toHaveBeenCalledWith(
      "u-ivanov",
      "edms.workAccountId",
      null,
      expect.anything(),
      "edms.work_mail"
    );
  });

  test("чужой ящик выбрать нельзя — 403 account_not_allowed", async () => {
    for (const accountId of ["acc-foreign", "acc-нет-такого"]) {
      const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
        token: TOKEN,
        body: { accountId }
      });

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe("account_not_allowed");
    }
    expect(mockedDocflow.setUserSetting).not.toHaveBeenCalled();
  });

  test("выданный ящик выбрать можно — 200", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-personal"]);

    const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
      token: TOKEN,
      body: { accountId: "acc-personal" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setUserSetting).toHaveBeenCalledWith(
      "u-ivanov",
      "edms.workAccountId",
      "acc-personal",
      expect.anything(),
      "edms.work_mail"
    );
  });

  test("чужой выбор не подменить: идентификатор работника берётся из сессии", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["acc-personal"]);
    const res = await request(app.baseUrl, "PUT", "/api/docflow/my-edms-mail", {
      token: TOKEN,
      // Попытка указать чужого работника в теле игнорируется.
      body: { accountId: "acc-personal", userId: "u-petrova", workerId: "u-petrova" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setUserSetting.mock.calls[0][0]).toBe("u-ivanov");
  });
});
