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

  test("ничего не выбрано — «первый готовый» НЕ подставляется (Р24)", () => {
    const director = account({ id: "acc-dir", username: "user2@mail.test", smtpHost: null });
    const post = account({ id: "acc-post", username: "post@mail.test" });

    const choice = selectSendAccount([director, post], { configuredId: null });

    // Оба ящика на сервере, но выбор за человеком: угадывать, от чьего имени уйдёт
    // официальное письмо, запрещено решением Р24.
    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("not_configured");
  });

  test("личный выбран, но отправить с него нечем — ОТКАЗ, а не подмена другим ящиком (T58)", () => {
    const halfConfigured = account({
      id: "acc-half",
      username: "half@mail.test",
      passwordEncrypted: "",
      smtpPasswordEncrypted: null
    });
    const service = account({ id: "acc-service", username: "service@mail.test" });

    const choice = selectSendAccount([halfConfigured, service], {
      personalId: "acc-half",
      configuredId: "acc-service",
      allowedIds: ["acc-half", "acc-service"]
    });

    // Выбранный работником ящик не подменяем: письмо ушло бы не от того адреса, который
    // человек выбрал. Причина называет ящик, а код объясняет интерфейсу, что делать.
    expect(choice.problemCode).toBe("smtp_not_configured");
    expect(choice.source).toBe("personal");
    expect(String(choice.problem)).toContain("half@mail.test");
  });

  test("служебный ящик задан, но такого ящика больше нет — отказ, а не подстановка другого", () => {
    const post = account({ id: "acc-post", username: "post@mail.test" });

    const choice = selectSendAccount([post], { configuredId: "acc-удалён" });

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("account_missing");
    expect(String(choice.problem)).toContain("acc-удалён");
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
    // Отказ объясняет ОБА законных пути: служебный ящик предприятия или личная рабочая почта.
    expect(String(choice.problem)).toContain("служебный ящик предприятия");
    expect(String(choice.problem)).toContain("личную рабочую почту");
  });

  test("ящик НЕ выбран, но подходящий РОВНО ОДИН — всё равно отказ (Р24)", () => {
    const only = account({ id: "only", username: "post@mail.test" });
    const notReady = account({ id: "bad", username: "user2@mail.test", smtpHost: null });

    // Раньше «единственный готовый» считался однозначным выбором. Решение Р24 это отменяет:
    // выбор делает работник (личная почта) или предприятие (служебный ящик), а не удача.
    const choice = selectSendAccount([notReady, only], {});

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("not_configured");
  });

  test("ничего не выбрано и готовых нет — понятная ошибка", () => {
    const choice = selectSendAccount(
      [account({ id: "a", smtpHost: null }), account({ id: "b", passwordEncrypted: "" })],
      {}
    );

    expect(choice.account).toBeNull();
    expect(choice.problemCode).toBe("not_configured");
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

describe("роль «приём» не требует SMTP (найдено при живом прогоне T25)", () => {
  test("внешняя приёмная без SMTP — это НЕ проблема: принимать почту SMTP не нужен", () => {
    // Ящик user2@mail.test на стенде без smtp_host. Для ОТПРАВКИ это блокер,
    // для ПРИЁМА — норма: письма приходят по IMAP/POP3.
    const view = serviceAccountView(account({ smtpHost: null }), { configuredId: "acc-1", requiresSmtp: false });

    expect(view.problem).toBeNull();
    expect(view.problemCode).toBe("ok");
    // Поля про SMTP остаются в ответе — просто как справка, а не как проблема.
    expect(view.account?.smtpConfigured).toBe(false);
    expect(view.account?.smtpHostConfigured).toBe(false);
  });

  test("для роли отправки та же почта без SMTP — по-прежнему проблема", () => {
    const view = serviceAccountView(account({ smtpHost: null }), { configuredId: "acc-1" });

    expect(view.problemCode).toBe("smtp_not_configured");
    expect(String(view.problem)).toContain("SMTP");
  });
});

describe("Р24: в СЭД разрешены ровно два ящика", () => {
  const personal = account({ id: "acc-personal", username: "ivanov@mail.test" });
  const service = account({ id: "acc-service", username: "post@mail.test" });
  const foreign = account({ id: "acc-foreign", username: "user2@mail.test" });
  const allowed = ["acc-personal", "acc-service"];

  test("личный рабочий ящик важнее служебного", () => {
    const choice = selectSendAccount([service, personal], {
      personalId: "acc-personal",
      configuredId: "acc-service",
      allowedIds: allowed
    });

    expect(choice.account?.id).toBe("acc-personal");
    expect(choice.source).toBe("personal");
    expect(choice.problem).toBeNull();
  });

  test("личного выбора нет — служебный внутренний", () => {
    const choice = selectSendAccount([service, personal], {
      configuredId: "acc-service",
      allowedIds: allowed
    });

    expect(choice.account?.id).toBe("acc-service");
    expect(choice.source).toBe("service");
  });

  test("явно переданный ящик вне разрешённых — отказ account_not_allowed", () => {
    for (const explicitId of ["acc-foreign", "acc-неизвестный"]) {
      const choice = selectSendAccount([service, personal, foreign], {
        explicitId,
        personalId: "acc-personal",
        configuredId: "acc-service",
        allowedIds: allowed
      });

      expect(choice.account).toBeNull();
      expect(choice.problemCode).toBe("account_not_allowed");
      expect(String(choice.problem)).toContain("нельзя");
    }
  });

  test("явно переданный ящик из разрешённых — можно, даже если это служебный", () => {
    const choice = selectSendAccount([service, personal], {
      explicitId: "acc-service",
      personalId: "acc-personal",
      configuredId: "acc-service",
      allowedIds: allowed
    });

    expect(choice.account?.id).toBe("acc-service");
    expect(choice.source).toBe("explicit");
  });

  test("внешняя приёмная в разрешённые не входит: сама по себе не выбирается", () => {
    const external = account({ id: "acc-external", username: "manufactory@kaluga.net" });

    const choice = selectSendAccount([external, service], {
      personalId: null,
      configuredId: "acc-service",
      allowedIds: ["acc-service"]
    });

    expect(choice.account?.id).toBe("acc-service");
    // А если её передать явно — отказ: с приёмной уходит только ответ контрагенту (композер).
    expect(
      selectSendAccount([external, service], { explicitId: "acc-external", allowedIds: ["acc-service"] }).problemCode
    ).toBe("account_not_allowed");
  });

  test("личный ящик исчез — отказ account_missing, БЕЗ ухода на служебный (T58)", () => {
    const choice = selectSendAccount([service], {
      personalId: "acc-удалён",
      configuredId: "acc-service",
      allowedIds: ["acc-удалён", "acc-service"]
    });

    // Решение Lead'а: выбранный ящик не подменяем даже когда его удалили — работник должен
    // узнать, что выбор больше не работает, и выбрать другой.
    expect(choice.problemCode).toBe("account_missing");
    expect(choice.account).toBeNull();
    expect(choice.source).toBe("personal");
    expect(String(choice.problem)).toContain("больше не существует");
  });
});
