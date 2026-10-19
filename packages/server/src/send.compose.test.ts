import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { standAccount, testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
// Документооборот здесь не проверяем, но без мока его исходники тянут @mailsense/core/directory,
// который в конфиге серверных тестов не отображён.
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Проброс полей отправки (T27, Р19).
 *
 * Письмо уходит с адреса СЛУЖЕБНОГО ящика, но с именем работника; для правила «ответ уходит
 * с ящика получения» нужен Reply-To. Адрес отправителя берётся из ящика и подмене из тела
 * не подлежит — это правило ядра, а маршрут обязан лишь не терять и не переписывать поля.
 */
const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };
const ComposeInputError = (core as unknown as { ComposeInputError: new (m: string) => Error }).ComposeInputError;

const TOKEN = "token:secretary";
/** Отправка и шаблон требуют сессии: маршруты закрыты общим requireAuth. */
const withToken = <T extends Record<string, unknown>>(options: T): T & { token: string } => ({ ...options, token: TOKEN });

let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(TOKEN, testUser("u-secretary", ["secretary"]));
  // Ящик стенда принадлежит секретарю: доступ идёт по владельцу, а не по праву.
  coreMocks.listAccounts.mockReturnValue([standAccount("u-secretary")]);
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

const base = { accountId: "acc-1", to: [{ address: "kto-to@mail.test" }], bodyText: "текст" };

describe("fromName и replyTo доходят до ядра как есть", () => {
  test("поля передаются без правок — даже с пробелами по краям", async () => {
    await request(app.baseUrl, "POST", "/api/emails/send", withToken({
      body: { ...base, fromName: "  Иванов И.И., аппарат  ", replyTo: "  manufactory@kaluga.net  " }
    }));

    expect(coreMocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: "  Иванов И.И., аппарат  ", replyTo: "  manufactory@kaluga.net  " })
    );
  });

  test("отсутствие полей не выдумывает их: работает прежний путь из настроек ящика", async () => {
    await request(app.baseUrl, "POST", "/api/emails/send", withToken({ body: base }));

    const compose = (coreMocks.sendEmail.mock.calls[0] as [Record<string, unknown>])[0];
    expect(compose.fromName).toBeUndefined();
    expect(compose.replyTo).toBeUndefined();
  });

  test("посторонний from в теле НЕ превращается в имя отправителя", async () => {
    await request(app.baseUrl, "POST", "/api/emails/send", withToken({ body: { ...base, from: "чужой@mail.test" } }));

    const compose = (coreMocks.sendEmail.mock.calls[0] as [Record<string, unknown>])[0];
    expect(compose.fromName).toBeUndefined();
    expect(compose.accountId).toBe("acc-1");
  });
});

describe("отказ по данным запроса — 400, а не 500", () => {
  test("ComposeInputError из ядра становится 400 с готовым текстом", async () => {
    coreMocks.sendEmail.mockRejectedValueOnce(new ComposeInputError("Имя отправителя длиннее 120 символов"));

    const res = await request(app.baseUrl, "POST", "/api/emails/send", withToken({
      body: { ...base, fromName: "очень длинное имя" }
    }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Имя отправителя длиннее 120 символов" });
  });

  test("прочие сбои отправки остаются 500 и не подменяются отказом данных", async () => {
    coreMocks.sendEmail.mockRejectedValueOnce(new Error("SMTP недоступен"));

    const res = await request(app.baseUrl, "POST", "/api/emails/send", withToken({ body: base }));

    expect(res.status).toBe(500);
  });
});

describe("шаблон письма: личная подпись работника (T27)", () => {
  test("useAccountSignature=0 → подпись ящика не подставляется", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=new&useAccountSignature=0", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(coreMocks.buildComposeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", mode: "new", useAccountSignature: false })
    );
  });

  test("без параметра подпись ящика работает как раньше (поле не задано)", async () => {
    await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=new", { token: TOKEN });

    const input = (coreMocks.buildComposeTemplate.mock.calls[0] as [Record<string, unknown>])[0];
    expect(input.useAccountSignature).toBeUndefined();
  });
});

describe("F-5: шаблон письма не падает 500 на негодных данных", () => {
  test("несуществующий ящик → 404 с русским текстом", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=нет-такого&mode=new", { token: TOKEN });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Ящик не найден" });
    expect(coreMocks.buildComposeTemplate).not.toHaveBeenCalled();
  });

  test("без accountId → 400 «Укажите accountId»", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?mode=new", { token: TOKEN });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Укажите accountId" });
  });

  test("неизвестный режим письма → 400", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=сам-придумал", { token: TOKEN });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Неизвестный режим письма" });
  });

  test("ответ по несуществующему письму → 404, а не пустой шаблон", async () => {
    coreMocks.getEmailView.mockReturnValue(null);

    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=reply&emailId=нет-такого", { token: TOKEN });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Письмо не найдено" });
    expect(coreMocks.buildComposeTemplate).not.toHaveBeenCalled();
  });

  test("ответ без письма → 400: цитировать нечего", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=reply", { token: TOKEN });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Укажите письмо для ответа или пересылки" });
  });

  test("годный ящик и новое письмо → 200 (поведение не изменилось)", async () => {
    const res = await request(app.baseUrl, "GET", "/api/compose-template?accountId=acc-1&mode=new", { token: TOKEN });

    expect(res.status).toBe(200);
    expect(coreMocks.buildComposeTemplate).toHaveBeenCalled();
  });
});

/**
 * Найдено ЖИВОЙ отправкой через стенд: при кривом теле запроса сервер отвечал 500
 * («compose.to.map is not a function», «No recipients defined»), и человек видел
 * «Внутренняя ошибка сервера» вместо того, что нужно поправить. Отказ почтового сервера —
 * тоже не сбой приложения: отдаём его текст как 502.
 */
describe("получатели и отказы почтового сервера", () => {
  const send = (body: Record<string, unknown>) =>
    request(app.baseUrl, "POST", "/api/emails/send", { token: TOKEN, body });

  test("адрес строкой — 400 с понятным текстом, до ядра не доходит", async () => {
    const res = await send({ ...base, to: "kto-to@mail.test" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("списком адресов");
    expect(coreMocks.sendEmail).not.toHaveBeenCalled();
  });

  test("пустой список получателей — 400", async () => {
    const res = await send({ ...base, to: [] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Не указаны получатели");
  });

  test("пустой адрес в списке — 400", async () => {
    const res = await send({ ...base, to: [{ address: "   " }] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("пустой адрес");
  });

  test("отказ почтового сервера — 502 с его текстом, а не 500", async () => {
    coreMocks.sendEmail.mockRejectedValueOnce(new Error("No recipients defined"));
    const res = await send({ ...base });
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("No recipients defined");
  });

  test("отказ при заборе почты — 502 с текстом сервера", async () => {
    coreMocks.fetchEmails.mockRejectedValueOnce(
      new Error("POP3 USER: -ERR [AUTH] Cleartext authentication disallowed on non-secure (SSL/TLS) connections")
    );
    const res = await request(app.baseUrl, "POST", "/api/accounts/acc-1/fetch", { token: TOKEN, body: {} });
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("Cleartext");
  });
});
