import { hasMailDefaults, mergeAccountDefaults, parseMailDefaults, MAIL_DEFAULTS_ENV } from "./mailDefaults.js";
import type { AccountInput } from "@mailsense/core";

/**
 * Умолчания почтового сервера (пункт 5 заказчика).
 *
 * Предприятие задаёт адрес сервера, порты, шифрование и способ входа один раз, работник
 * вводит только адрес ящика и пароль. Проверяем главное: заполненное человеком не перетирается,
 * а мусор в переменной не роняет создание ящика.
 */
function input(over: Partial<AccountInput> = {}): AccountInput {
  return {
    protocol: "pop3",
    // Форма может прислать пустые поля — это и есть «работник ничего не указывал».
    host: "",
    port: 0,
    tls: "" as AccountInput["tls"],
    username: "ivanov@kniitmu.ru",
    password: "почтовый-пароль",
    authType: "" as AccountInput["authType"],
    ...over
  };
}

describe("разбор умолчаний", () => {
  test("пустая строка — это «не задано», а не ошибка", () => {
    expect(parseMailDefaults("")).toEqual({ defaults: {}, error: null });
    expect(parseMailDefaults(null)).toEqual({ defaults: {}, error: null });
  });

  test("мусор не роняет сервер: причина едет в журнал", () => {
    const broken = parseMailDefaults("{это не json");
    expect(broken.defaults).toEqual({});
    expect(broken.error).toContain(MAIL_DEFAULTS_ENV);
    expect(parseMailDefaults("[1,2,3]").error).toContain("объект");
  });

  test("читаются три блока, мусорные поля игнорируются", () => {
    const { defaults, error } = parseMailDefaults(
      JSON.stringify({
        pop3: { host: " 192.168.1.10 ", port: "995", tls: "ssl", authType: "login", лишнее: "да" },
        imap: { host: "192.168.1.10", port: 993 },
        smtp: { host: "192.168.1.10", port: 70000 },
        чужой: { host: "нет" }
      })
    );
    expect(error).toBeNull();
    expect(defaults.pop3).toEqual({ host: "192.168.1.10", port: 995, tls: "ssl", authType: "login" });
    expect(defaults.imap).toEqual({ host: "192.168.1.10", port: 993 });
    // Порт вне диапазона — не умолчание: лучше пусто, чем «подключаемся в никуда».
    expect(defaults.smtp).toEqual({ host: "192.168.1.10" });
    expect(hasMailDefaults(defaults)).toBe(true);
  });
});

describe("дополнение ящика умолчаниями", () => {
  const defaults = parseMailDefaults(
    JSON.stringify({
      pop3: { host: "192.168.1.10", port: 995, tls: "ssl", authType: "login" },
      smtp: { host: "192.168.1.10", port: 465, tls: "ssl", authType: "login" }
    })
  ).defaults;

  test("пустые поля берутся из умолчаний, работник вводит только адрес и пароль", () => {
    const merged = mergeAccountDefaults(input(), defaults);
    expect(merged).toMatchObject({
      host: "192.168.1.10",
      port: 995,
      tls: "ssl",
      authType: "login",
      smtpHost: "192.168.1.10",
      smtpPort: 465,
      smtpTls: "ssl",
      smtpAuthType: "login"
    });
  });

  test("заполненное человеком не перетирается", () => {
    const merged = mergeAccountDefaults(
      input({ host: "10.168.101.3", port: 110, tls: "starttls", authType: "plain", smtpHost: "10.168.101.3", smtpPort: 25 }),
      defaults
    );
    expect(merged).toMatchObject({
      host: "10.168.101.3",
      port: 110,
      tls: "starttls",
      authType: "plain",
      smtpHost: "10.168.101.3",
      smtpPort: 25,
      // Незаполненный TLS отправки умолчание всё равно закрывает.
      smtpTls: "ssl"
    });
  });

  test("умолчания не трогают логин и пароли", () => {
    const merged = mergeAccountDefaults(input({ password: "секрет" }), defaults);
    expect(merged.username).toBe("ivanov@kniitmu.ru");
    expect(merged.password).toBe("секрет");
  });

  test("без умолчаний ящик остаётся как был", () => {
    const original = input({ host: "mail.test", port: 110 });
    expect(mergeAccountDefaults(original, {})).toEqual(original);
  });

  test("умолчания IMAP не применяются к POP3-ящику", () => {
    const imapOnly = parseMailDefaults(JSON.stringify({ imap: { host: "imap.test", port: 993 } })).defaults;
    const merged = mergeAccountDefaults(input(), imapOnly);
    expect(merged.host).toBe("");
    expect(merged.port).toBe(0);
  });
});
