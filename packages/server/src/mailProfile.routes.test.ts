import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Личный профиль почты (T34/T35) — вещь РАБОТНИКА, а не предприятия (Р18).
 *
 * Контракт полей и правила проверяет ЯДРО (task-34): displayName, signatureText,
 * signatureEnabled, signaturePosition (above/below), replyQuote, replyAttribution (ru/en).
 * Роль маршрута — транспорт и честный перевод отказов ядра:
 *   • работник берётся из подтверждённой сессии (ключ — LDAP-логин);
 *   • патч уходит в ядро КАК ЕСТЬ (частичное обновление не затирает остальное);
 *   • MailProfileInputError ядра → 400 с его русским текстом, прочие сбои → 500.
 * Локальность маршрута (не проксируется) — в client.mode.test.ts и proxy.mail.test.ts.
 */
const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };
const MailProfileInputError = (core as unknown as { MailProfileInputError: new (m: string) => Error })
  .MailProfileInputError;

const token = (role: string) => "token:" + role;
let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(token("secretary"), testUser("u-secretary", ["secretary"], { ldapUid: "ivanov_ii" }));
  mockedDocflow.__sessions.set(token("executor"), testUser("u-executor", ["executor"], { ldapUid: "petrova_ma" }));
  // Пользователь без учётки в каталоге: профиль всё равно личный — ключ по id.
  mockedDocflow.__sessions.set(token("local"), testUser("u-local", ["admin"], { ldapUid: null }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("кто и как получает профиль", () => {
  test("без сессии — 401, ядро не спрашивают", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-profile");

    expect(res.status).toBe(401);
    expect(coreMocks.getMailProfile).not.toHaveBeenCalled();
  });

  test("пустой профиль отдаётся без ошибки, ключ — LDAP-логин работника", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-profile", { token: token("secretary") });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: "ivanov_ii",
      displayName: "",
      signatureText: "",
      signatureEnabled: true,
      signaturePosition: "below",
      replyQuote: true,
      replyAttribution: "ru",
      updatedAt: null
    });
    expect(coreMocks.getMailProfile).toHaveBeenCalledWith("ivanov_ii");
  });

  test("доступен ЛЮБОМУ вошедшему: исполнителю тоже, без settings.manage", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-profile", { token: token("executor") });

    expect(res.status).toBe(200);
    expect(coreMocks.getMailProfile).toHaveBeenCalledWith("petrova_ma");
  });

  test("без учётки в каталоге ключом становится id — профиль всё равно личный", async () => {
    const res = await request(app.baseUrl, "GET", "/api/mail-profile", { token: token("local") });

    expect(res.status).toBe(200);
    expect(coreMocks.getMailProfile).toHaveBeenCalledWith("u-local");
  });
});

describe("обновление профиля — частичное", () => {
  test("PUT отдаёт профиль ядра и передаёт ТОЛЬКО присланные поля", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", {
      token: token("secretary"),
      body: { displayName: "Иванов И.И., аппарат" }
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: "ivanov_ii",
      displayName: "Иванов И.И., аппарат",
      signatureText: "",
      signatureEnabled: true
    });
    // ⚠️ Только присланное поле: иначе патч затрёт остальные настройки работника.
    expect(coreMocks.setMailProfile).toHaveBeenCalledWith("ivanov_ii", { displayName: "Иванов И.И., аппарат" });
  });

  test("несколько полей сразу, включая логические и перечисления — как есть", async () => {
    await request(app.baseUrl, "PUT", "/api/mail-profile", {
      token: token("secretary"),
      body: { signatureEnabled: true, signaturePosition: "above", replyQuote: false, replyAttribution: "en" }
    });

    expect(coreMocks.setMailProfile).toHaveBeenCalledWith("ivanov_ii", {
      signatureEnabled: true,
      signaturePosition: "above",
      replyQuote: false,
      replyAttribution: "en"
    });
  });

  test("пустое тело — ничего не меняем, профиль возвращается как есть", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", { token: token("secretary"), body: {} });

    expect(res.status).toBe(200);
    expect(coreMocks.setMailProfile).toHaveBeenCalledWith("ivanov_ii", {});
  });

  test("без сессии PUT отклоняется и ядро не трогают", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", { body: { displayName: "Кто-то" } });

    expect(res.status).toBe(401);
    expect(coreMocks.setMailProfile).not.toHaveBeenCalled();
  });

  test("тело не объект — 400 и ядро не трогают", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", { token: token("secretary"), body: [1, 2] });

    expect(res.status).toBe(400);
    expect(coreMocks.setMailProfile).not.toHaveBeenCalled();
  });
});

describe("отказ ядра по данным профиля — 400 с его текстом, не 500", () => {
  const cases = [
    "Отображаемое имя длиннее 120 символов",
    "Отображаемое имя не должно содержать переводы строк",
    "Подпись длиннее 4000 символов",
    "Недопустимое значение поля «Положение подписи»",
    "Неизвестное поле профиля: «signature_text»"
  ];

  it.each(cases)("текст ядра доходит до клиента дословно: %s", async (text) => {
    coreMocks.setMailProfile.mockRejectedValueOnce(new MailProfileInputError(text));

    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", {
      token: token("secretary"),
      body: { displayName: "что-то" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: text, code: "bad_profile" });
    // Ядро вызвано ровно один раз: отказ не должен превращаться в повторную запись.
    expect(coreMocks.setMailProfile).toHaveBeenCalledTimes(1);
  });

  test("сбой базы, а не данных, остаётся 500 — отказ данных не подменяет собой всё", async () => {
    coreMocks.setMailProfile.mockRejectedValueOnce(new Error("SQLITE_BUSY"));

    const res = await request(app.baseUrl, "PUT", "/api/mail-profile", {
      token: token("secretary"),
      body: { displayName: "Иванов" }
    });

    expect(res.status).toBe(500);
  });
});
