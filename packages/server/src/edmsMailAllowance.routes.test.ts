import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { createApp } from "./app.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Выдача работнику ящиков «почты для СЭД» (task-56) — маршрут администратора.
 *
 * Проверяем три опоры: право settings.manage, честные отказы (нет ящика — 400, не админ — 403)
 * и отзыв, который СБРАСЫВАЕТ уже сделанный выбор работника.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const READY = {
  id: "acc-personal",
  username: "ivanov@mail.test",
  // Работник, которому выдаём, — ldapUid «petrova_ma» (см. getUser ниже): ящики берутся его.
  ownerUserId: "petrova_ma",
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
/** Выданный ящик без SMTP: администратор должен видеть его в allowed с флагом, а не «ничего». */
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
const PATH = "/api/docflow/users/u-ivanov/edms-mail-allowance";
let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set("token:admin", testUser("u-admin", ["admin"], { ldapUid: "admin" }));
  mockedDocflow.__sessions.set("token:executor", testUser("u-executor", ["executor"], { ldapUid: "petrova_ma" }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedCore.listAccounts.mockReturnValue([SERVICE, READY, NO_SMTP]);
  mockedDocflow.getServiceAccountState.mockResolvedValue({ explicit: true, accountId: "acc-service" });
  mockedDocflow.getAllowedWorkAccounts.mockResolvedValue([]);
  mockedDocflow.getUser.mockImplementation(async (id: string) => ({
    id,
    fullName: "Петрова М.А.",
    email: "petrova_ma@stand.test",
    ldapUid: "petrova_ma"
  }));
  mockedDocflow.setAllowedWorkAccounts.mockImplementation(async (_userId: string, addresses: string[]) => ({
    addresses,
    resetChoice: null
  }));
});

describe("право на выдачу: settings.manage", () => {
  test("рядовому работнику — 403, ничего не выдаём", async () => {
    const res = await request(app.baseUrl, "PUT", PATH, {
      token: "token:executor",
      body: { accountIds: ["ivanov@mail.test"] }
    });

    expect(res.status).toBe(403);
    expect(mockedDocflow.setAllowedWorkAccounts).not.toHaveBeenCalled();
  });

  test("без сессии — 401", async () => {
    const res = await request(app.baseUrl, "GET", PATH);

    expect(res.status).toBe(401);
  });
});

describe("GET выдачи", () => {
  test("администратор видит выданное и разрешённое", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["ivanov@mail.test"]);

    const res = await request(app.baseUrl, "GET", PATH, { token: "token:admin" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: "u-ivanov",
      // Источник правды — адреса; идентификаторы оставлены для прежнего экрана.
      addresses: ["ivanov@mail.test"],
      accountIds: ["acc-personal"],
      resetChoice: null
    });
    // Администратор видит РЕАЛЬНОСТЬ работника: служебный ящик и его СВОИ ящики на сервере
    // предприятия (списка адресов больше нет — заказчик), плюс то, что он выдал сам.
    expect((res.body as { allowed: Array<{ id: string; kind: string }> }).allowed).toEqual([
      { id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: true, kind: "service" },
      { id: "acc-personal", username: "ivanov@mail.test", host: "mail.test", smtpReady: true, kind: "personal" },
      { id: "acc-nosmtp", username: "petrova_ma@mail.test", host: "mail.test", smtpReady: false, kind: "personal" }
    ]);
  });

  test("выданный без SMTP виден администратору с честным флагом (дефект T58)", async () => {
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["petrova_ma@mail.test"]);

    const res = await request(app.baseUrl, "GET", PATH, { token: "token:admin" });

    expect(res.status).toBe(200);
    // Раньше здесь был только служебный ящик: выдача выглядела успешной, а эффекта не было.
    expect((res.body as { allowed: Array<{ id: string; smtpReady: boolean }> }).allowed).toMatchObject([
      { id: "acc-service", smtpReady: true },
      { id: "acc-personal", smtpReady: true, kind: "personal" },
      { id: "acc-nosmtp", smtpReady: false, kind: "personal" }
    ]);
  });

  test("несуществующий работник — 404", async () => {
    mockedDocflow.getUser.mockResolvedValue(null);

    const res = await request(app.baseUrl, "GET", PATH, { token: "token:admin" });

    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("user_not_found");
  });
});

describe("PUT выдачи", () => {
  test("выдача сохраняется, дубликаты схлопываются", async () => {
    // Заглушка хранилища отдаёт то же, что записали (как настоящая таблица).
    mockedDocflow.getAllowedWorkAccounts.mockResolvedValue(["ivanov@mail.test", "post@mail.test"]);
    const res = await request(app.baseUrl, "PUT", PATH, {
      token: "token:admin",
      body: { accountIds: ["acc-personal", " acc-personal ", "acc-service"] }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.setAllowedWorkAccounts).toHaveBeenCalledWith(
      "u-ivanov",
      ["ivanov@mail.test", "post@mail.test"],
      expect.objectContaining({ id: "u-admin" }),
      expect.anything()
    );
    expect((res.body as { addresses: string[] }).addresses).toEqual(["ivanov@mail.test", "post@mail.test"]);
  });

  test("несуществующий ящик — 400 unknown_account, выдача не пишется", async () => {
    const res = await request(app.baseUrl, "PUT", PATH, {
      token: "token:admin",
      body: { accountIds: ["acc-нет-такого"] }
    });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("unknown_account");
    expect(mockedDocflow.setAllowedWorkAccounts).not.toHaveBeenCalled();
  });

  test("не список — 400 bad_addresses", async () => {
    const res = await request(app.baseUrl, "PUT", PATH, {
      token: "token:admin",
      body: { accountIds: "acc-personal" }
    });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("bad_addresses");
  });

  test("отзыв возвращает сброшенный выбор работника", async () => {
    mockedDocflow.setAllowedWorkAccounts.mockImplementation(async (_userId: string, addresses: string[]) => ({
      addresses,
      resetChoice: "acc-personal"
    }));

    const res = await request(app.baseUrl, "PUT", PATH, {
      token: "token:admin",
      body: { accountIds: [] }
    });

    expect(res.status).toBe(200);
    // Интерфейс администратора должен увидеть, что выбор работника сброшен.
    expect((res.body as { resetChoice: string | null }).resetChoice).toBe("acc-personal");
  });
});
