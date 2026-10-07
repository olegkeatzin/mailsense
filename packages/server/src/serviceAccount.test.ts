import { selectSendAccount, serviceAccountView, smtpReady, type SendAccountLike } from "./serviceAccount.js";

/**
 * Выбор ящика отправки (Р12, task-11).
 *
 * Раньше и /forward, и /dispatch брали «первый imap-ящик»: на предприятии с несколькими
 * ящиками это угадывание, и на стенде им оказался ящик самого директора БЕЗ SMTP —
 * письмо руководителю либо ушло бы не от того адреса, либо упало без объяснения.
 *
 * Здесь проверяется приоритет выбора, готовность ящика к отправке и понятность отказа —
 * то, ради чего помощник вынесен из маршрутов: одна логика на два маршрута, проверяемая
 * без HTTP и без базы.
 */

const account = (patch: Partial<SendAccountLike> = {}): SendAccountLike => ({
  id: "acc-1",
  protocol: "imap",
  host: "mail.test",
  port: 993,
  tls: "ssl",
  username: "test@mail.test",
  authType: "password",
  // Пароль ящика в шифре: им же пользуется SMTP, если отдельного пароля нет.
  passwordEncrypted: "ШИФР-ПАРОЛЬ",
  smtpHost: "mail.test",
  smtpPort: 465,
  smtpTls: "ssl",
  smtpUsername: "test@mail.test",
  smtpPasswordEncrypted: null,
  ...patch
});

const SECRET = "ШИФР-ПАРОЛЬ";

describe("готовность к отправке — то же правило, что у самой отправки", () => {
  test("хост SMTP и пароль ящика — готов", () => {
    expect(smtpReady(account())).toBe(true);
  });

  test("отдельный пароль SMTP тоже годится", () => {
    expect(smtpReady(account({ passwordEncrypted: "", smtpPasswordEncrypted: "ШИФР-SMTP" }))).toBe(true);
  });

  test("хост есть, а паролей нет — НЕ готов: иначе UI покажет «настроено», а письмо не уйдёт", () => {
    expect(smtpReady(account({ passwordEncrypted: "", smtpPasswordEncrypted: null }))).toBe(false);
  });

  test("нет хоста SMTP — не готов, даже если пароли есть", () => {
    expect(smtpReady(account({ smtpHost: null }))).toBe(false);
  });
});

describe("приоритет выбора ящика", () => {
  test("явно указанный в теле запроса важнее служебного", () => {
    const explicit = account({ id: "acc-explicit", username: "explicit@mail.test" });
    const service = account({ id: "acc-service", username: "service@mail.test" });

    const choice = selectSendAccount([service, explicit], {
      explicitId: "acc-explicit",
      configuredId: "acc-service"
    });

    expect(choice.account?.id).toBe("acc-explicit");
    expect(choice.source).toBe("explicit");
    expect(choice.problem).toBeNull();
    expect(choice.problemCode).toBe("ok");
    expect(choice.warning).toBeNull();
  });

  test("служебный из настроек важнее первого попавшегося", () => {
    const first = account({ id: "acc-first", username: "user2@mail.test", smtpHost: null });
    const service = account({ id: "acc-service", username: "test@mail.test" });

    const choice = selectSendAccount([first, service], { configuredId: "acc-service" });

    expect(choice.account?.id).toBe("acc-service");
    expect(choice.source).toBe("service");
    expect(choice.problem).toBeNull();
  });

  test("служебный ящик не задан — берём первый ГОТОВЫЙ, но предупреждаем", () => {
    const director = account({ id: "acc-dir", username: "user2@mail.test", smtpHost: null });
    const post = account({ id: "acc-post", username: "post@mail.test" });

    const choice = selectSendAccount([director, post], { configuredId: null });

    // Ящик директора пропущен: у него нет SMTP, письмо оттуда не уйдёт.
    expect(choice.account?.id).toBe("acc-post");
    expect(choice.source).toBe("fallback");
    expect(choice.problem).toBeNull();
    // Не молчим: без служебного ящика выбор — всё ещё угадывание.
    expect(String(choice.warning)).toContain("служебн");
    expect(String(choice.warning)).toContain("post@mail.test");
  });

  test("ящик с хостом SMTP, но без пароля, при выборе пропускается", () => {
    const halfConfigured = account({
      id: "acc-half",
      username: "half@mail.test",
      passwordEncrypted: "",
      smtpPasswordEncrypted: null
    });
    const ready = account({ id: "acc-ready", username: "ready@mail.test" });

    const choice = selectSendAccount([halfConfigured, ready], {});
    expect(choice.account?.id).toBe("acc-ready");
  });

  test("служебный ящик задан, но такого ящика больше нет — откат с предупреждением", () => {
    const post = account({ id: "acc-post", username: "post@mail.test" });

    const choice = selectSendAccount([post], { configuredId: "acc-удалён" });

    expect(choice.account?.id).toBe("acc-post");
    expect(choice.source).toBe("fallback");
    expect(String(choice.warning)).toContain("не найден");
  });

  test("явно указанный, но несуществующий ящик — отказ, а не молчаливая подмена", () => {
    const choice = selectSendAccount([account()], { explicitId: "acc-призрак" });

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("unknown_account");
    expect(String(choice.problem)).toContain("не найден");
  });
});

describe("отказ объясняется словами и машинным кодом", () => {
  test("у выбранного ящика нет SMTP — понятная ошибка с логином", () => {
    const choice = selectSendAccount([account({ username: "user2@mail.test", smtpHost: null })], {
      explicitId: "acc-1"
    });

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("smtp_not_configured");
    expect(String(choice.problem)).toContain("user2@mail.test");
    expect(String(choice.problem)).toContain("SMTP");
  });

  test("у выбранного ящика нет пароля отправки — это тоже «нечем отправить»", () => {
    const choice = selectSendAccount(
      [account({ username: "half@mail.test", passwordEncrypted: "", smtpPasswordEncrypted: null })],
      { explicitId: "acc-1" }
    );

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("smtp_not_configured");
    expect(String(choice.problem)).toContain("парол");
  });

  test("выбор снят явно — «первый попавшийся» запрещён, даже если ящик готов", () => {
    const choice = selectSendAccount([account()], { cleared: true });

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("not_configured");
    // Текст заморожен решением Lead'а: его показывает аппарату интерфейс.
    expect(String(choice.problem)).toBe(
      "Служебный ящик не выбран: укажите его в настройках СЭД (Служебный ящик), иначе отправлять нечем."
    );
  });

  test("ящик НЕ выбран и подходящих несколько — отказ: «первый готовый» может быть личным ящиком директора", () => {
    const choice = selectSendAccount(
      [account({ id: "a", username: "post@mail.test" }), account({ id: "b", username: "user2@mail.test" })],
      {}
    );

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("not_configured");
    expect(String(choice.problem)).toContain("не выбран");
    expect(String(choice.problem)).toContain("Служебный ящик");
  });

  test("ящик НЕ выбран, но подходящий РОВНО ОДИН — выбор однозначен, отправляем", () => {
    const only = account({ id: "only", username: "post@mail.test" });
    const notReady = account({ id: "bad", username: "user2@mail.test", smtpHost: null });

    const choice = selectSendAccount([notReady, only], {});

    expect(choice.account?.id).toBe("only");
    expect(choice.problem).toBeNull();
    expect(choice.problemCode).toBe("ok");
    expect(String(choice.warning)).toContain("post@mail.test");
  });

  test("ни у одного ящика нет готовой отправки — понятная ошибка", () => {
    const choice = selectSendAccount(
      [account({ id: "a", smtpHost: null }), account({ id: "b", passwordEncrypted: "" })],
      {}
    );

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("smtp_not_configured");
  });

  test("ящиков нет вовсе — понятная ошибка", () => {
    const choice = selectSendAccount([], {});

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("no_account");
    expect(String(choice.problem)).toContain("ящик");
  });

  test("служебный ящик без SMTP не подменяется другим ящиком молча", () => {
    const service = account({ id: "acc-service", username: "test@mail.test", smtpHost: null });
    const other = account({ id: "acc-other", username: "other@mail.test" });

    const choice = selectSendAccount([service, other], { configuredId: "acc-service" });

    // Выбран служебный — и честно сказано, что отправлять нечем. Тихо уйти с чужого
    // адреса нельзя: получатель увидит не того отправителя.
    expect(choice.account?.id).toBe("acc-service");
    expect(choice.problemCode).toBe("smtp_not_configured");
  });
});

describe("параметры для подсказки аппарату: пароль не утекает", () => {
  test("отдаёт хост, порт, tls и логины, но ни одного пароля", () => {
    const view = serviceAccountView(account(), { configuredId: "acc-1" });

    expect(view.configured).toBe(true);
    expect(view.problemCode).toBe("ok");
    expect(view.account).toMatchObject({
      accountId: "acc-1",
      name: "test@mail.test",
      username: "test@mail.test",
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      smtpUsername: "test@mail.test",
      smtpHost: "mail.test",
      smtpPort: 465,
      smtpHostConfigured: true,
      smtpConfigured: true
    });
    expect(view.problem).toBeNull();
    // Полей с паролем в ответе быть не должно (authType="password" — это значение, не пароль).
    expect(Object.keys(view.account ?? {})).not.toContain("passwordEncrypted");
    expect(Object.keys(view.account ?? {})).not.toContain("smtpPasswordEncrypted");
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("логин SMTP — отдельный, если задан: иначе аппарат вводит не тот логин", () => {
    const view = serviceAccountView(account({ smtpUsername: "smtp@mail.test" }), { configuredId: "acc-1" });
    expect(view.account?.smtpUsername).toBe("smtp@mail.test");
  });

  test("ящик не задан — account: null, машинный код not_configured и текст, что делать", () => {
    const view = serviceAccountView(null, { configuredId: null });

    expect(view.configured).toBe(false);
    expect(view.account).toBeNull();
    expect(view.problemCode).toBe("not_configured");
    expect(String(view.problem).toLowerCase()).toContain("служебн");
  });

  test("выбранный ящик удалён — это НЕ «не задан», и код это говорит (account_missing)", () => {
    const view = serviceAccountView(null, { configuredId: "acc-удалён" });

    expect(view.configured).toBe(true); // выбор в настройках ЕСТЬ, а ящика больше нет
    expect(view.account).toBeNull();
    expect(view.problemCode).toBe("account_missing");
    expect(String(view.problem)).toContain("не существует");
  });

  test("ящик без SMTP: параметры видны, но problem и код говорят, что отправлять нечем", () => {
    const view = serviceAccountView(account({ smtpHost: null }), { configuredId: "acc-1" });

    expect(view.account?.smtpHostConfigured).toBe(false);
    expect(view.account?.smtpConfigured).toBe(false);
    expect(view.problemCode).toBe("smtp_not_configured");
    expect(String(view.problem)).toContain("SMTP");
  });

  test("problem — плоский текст без разметки (XSS-чеклист)", () => {
    const view = serviceAccountView(account({ username: "<b>логин</b>" }), { configuredId: "acc-1" });
    // Сервер не «санитизирует» чужой текст и не строит HTML: он отдаёт ДАННЫЕ,
    // а рендерит их клиент текстом. Разметки сервер не добавляет.
    expect(String(view.problem ?? "")).not.toMatch(/<[a-z]/i);
    expect(JSON.stringify(view)).toContain("<b>логин</b>");
  });
});
