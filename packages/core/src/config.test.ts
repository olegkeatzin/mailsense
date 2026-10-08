import { loadConfig, parseMailboxes } from "./config.js";

/**
 * Конфигурация читается из окружения один раз при старте. Ошибка здесь тихо
 * ломает всё приложение, поэтому проверяем и значения по умолчанию, и разбор env.
 */
const KEYS = [
  "MAILSENSE_DATA_DIR",
  "MAILSENSE_PORT",
  "MAILSENSE_HOST",
  "MAILSENSE_AI_BASE_URL",
  "MAILSENSE_AI_API_KEY",
  "MAILSENSE_AI_MODEL",
  "MAILSENSE_AI_MULTIMODAL",
  "MAILSENSE_AI_TIMEOUT_MS",
  "MAILSENSE_AI_OCR_BASE_URL",
  "MAILSENSE_AI_OCR_MODEL",
  "MAILSENSE_MAIL_USER",
  "MAILSENSE_MAIL_PASS",
  "MAILSENSE_MAIL_HOST",
  "MAILSENSE_MAIL_PORT",
  "MAILSENSE_SEED_ACCOUNT",
  "MAILSENSE_MAILBOXES",
  "MAILSENSE_DOCFLOW_URL"
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("OCR-источник и OCR-модель из окружения", () => {
  test("переменные подхватываются", () => {
    process.env.MAILSENSE_AI_OCR_BASE_URL = "http://100.74.62.22:3010/v1";
    process.env.MAILSENSE_AI_OCR_MODEL = "glm-ocr";

    const ai = loadConfig().ai;
    expect(ai.ocrBaseUrl).toBe("http://100.74.62.22:3010/v1");
    expect(ai.ocrModel).toBe("glm-ocr");
  });

  test("без переменных — undefined, а не пустая строка", () => {
    const ai = loadConfig().ai;
    expect(ai.ocrBaseUrl).toBeUndefined();
    expect(ai.ocrModel).toBeUndefined();
  });

  test("пустая переменная или одни пробелы = «не задано»", () => {
    process.env.MAILSENSE_AI_OCR_BASE_URL = "";
    process.env.MAILSENSE_AI_OCR_MODEL = "   ";
    const ai = loadConfig().ai;
    expect(ai.ocrBaseUrl).toBeUndefined();
    expect(ai.ocrModel).toBeUndefined();
  });

  test("пробелы вокруг значения обрезаются", () => {
    process.env.MAILSENSE_AI_OCR_MODEL = "  glm-ocr  ";
    expect(loadConfig().ai.ocrModel).toBe("glm-ocr");
  });
});

describe("ящики из MAILSENSE_MAILBOXES", () => {
  test("нормальный список читается целиком", () => {
    const r = parseMailboxes(
      JSON.stringify([
        {
          username: "post@mail.test",
          password: "secret",
          protocol: "imap",
          host: "mail.test",
          port: 993,
          tls: true,
          smtpHost: "mail.test",
          smtpPort: 465,
          smtpTls: true
        },
        { username: "pop3@mail.test", password: "p2", protocol: "pop3", host: "mail.test", port: 995, tls: true }
      ])
    );

    expect(r.errors).toEqual([]);
    expect(r.mailboxes).toHaveLength(2);
    expect(r.mailboxes[0]).toMatchObject({
      username: "post@mail.test",
      password: "secret",
      protocol: "imap",
      host: "mail.test",
      port: 993,
      tls: "ssl",
      smtpHost: "mail.test",
      smtpPort: 465,
      smtpTls: "ssl",
      authType: "login"
    });
    expect(r.mailboxes[1]).toMatchObject({ protocol: "pop3", tls: "ssl" });
  });

  test("tls принимает и булево, и строку режима", () => {
    const r = parseMailboxes(
      JSON.stringify([
        { username: "a@mail.test", password: "p", protocol: "imap", host: "h", port: 143, tls: false },
        { username: "b@mail.test", password: "p", protocol: "imap", host: "h", port: 587, tls: "starttls" }
      ])
    );
    expect(r.errors).toEqual([]);
    expect(r.mailboxes[0].tls).toBe("none");
    expect(r.mailboxes[1].tls).toBe("starttls");
  });

  test("пустая переменная — это «списка нет», а не ошибка", () => {
    expect(parseMailboxes(undefined)).toEqual({ mailboxes: [], errors: [], warnings: [] });
    expect(parseMailboxes("   ")).toEqual({ mailboxes: [], errors: [], warnings: [] });
  });

  test("неизвестное поле — предупреждение, а не отказ: ящик остаётся", () => {
    // Опечатка (smtpPortt) иначе тихо не применилась бы, и человек искал бы причину в другом месте.
    const r = parseMailboxes(
      JSON.stringify([
        {
          username: "post@mail.test",
          password: "p",
          protocol: "imap",
          host: "h",
          port: 993,
          tls: true,
          smtpPortt: 465,
          bcc: "x"
        }
      ])
    );

    expect(r.errors).toEqual([]);
    expect(r.mailboxes).toHaveLength(1);
    expect(r.mailboxes[0].username).toBe("post@mail.test");
    expect(r.warnings).toEqual(["ящик #1 (post@mail.test): неизвестные поля bcc, smtpPortt — пропущены"]);
  });

  test("у нормального ящика предупреждений нет", () => {
    const r = parseMailboxes(
      JSON.stringify([{ username: "post@mail.test", password: "p", protocol: "imap", host: "h", port: 993, tls: true }])
    );
    expect(r.warnings).toEqual([]);
  });

  test("битый JSON — одна понятная ошибка, а не падение", () => {
    const r = parseMailboxes("[{это не json");
    expect(r.mailboxes).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("JSON");
  });

  test("JSON не массив — ошибка", () => {
    const r = parseMailboxes('{"username": "a@mail.test"}');
    expect(r.mailboxes).toEqual([]);
    expect(r.errors[0]).toContain("массив");
  });

  test("плохой элемент пропускается, остальные остаются", () => {
    const r = parseMailboxes(
      JSON.stringify([
        { username: "ok@mail.test", password: "p", protocol: "imap", host: "h", port: 993, tls: true },
        { username: "", password: "p", protocol: "imap", host: "h", port: 993, tls: true },
        { username: "bad-proto@mail.test", password: "p", protocol: "smtp", host: "h", port: 993, tls: true },
        { username: "bad-port@mail.test", password: "p", protocol: "imap", host: "h", port: "993", tls: true },
        { username: "no-host@mail.test", password: "p", protocol: "imap", port: 993, tls: true },
        "просто строка"
      ])
    );

    expect(r.mailboxes.map((m) => m.username)).toEqual(["ok@mail.test"]);
    expect(r.errors).toHaveLength(5);
    // В причинах видно, какой именно ящик пропущен (по номеру в списке или по адресу).
    expect(r.errors.join(" ")).toContain("протокол");
    expect(r.errors.join(" ")).toContain("порт");
  });
});

describe("значения по умолчанию", () => {
  test("порты, адрес прослушивания и ИИ", () => {
    const c = loadConfig();
    expect(c.port).toBe(8123);
    expect(c.host).toBe("127.0.0.1");
    expect(c.ai.baseUrl).toBe("http://localhost:8080/v1");
    expect(c.ai.multimodal).toBe(true);
    expect(c.ai.timeoutMs).toBe(120000);
    expect(c.seedAccount).toBe(false);
    expect(c.docflowServerUrl).toBeNull();
  });

  test("без логина и пароля почтовый аккаунт не создаётся", () => {
    expect(loadConfig().defaultAccount).toBeNull();
  });

  test("каталог данных по умолчанию — рядом с процессом", () => {
    expect(loadConfig().dataDir).toContain("data");
  });
});

describe("переменные окружения", () => {
  test("порт и хост читаются как числа и строки", () => {
    process.env.MAILSENSE_PORT = "9000";
    process.env.MAILSENSE_HOST = "0.0.0.0";
    const c = loadConfig();
    expect(c.port).toBe(9000);
    expect(c.host).toBe("0.0.0.0");
  });

  test("multimodal включается только точным true", () => {
    process.env.MAILSENSE_AI_MULTIMODAL = "false";
    expect(loadConfig().ai.multimodal).toBe(false);
    process.env.MAILSENSE_AI_MULTIMODAL = "1";
    expect(loadConfig().ai.multimodal).toBe(false);
    process.env.MAILSENSE_AI_MULTIMODAL = "true";
    expect(loadConfig().ai.multimodal).toBe(true);
  });

  test("аккаунт создаётся только когда заданы и логин, и пароль", () => {
    process.env.MAILSENSE_MAIL_USER = "test@mail.test";
    expect(loadConfig().defaultAccount).toBeNull();

    process.env.MAILSENSE_MAIL_PASS = "secret";
    const acc = loadConfig().defaultAccount;
    expect(acc).not.toBeNull();
    expect(acc!.username).toBe("test@mail.test");
    expect(acc!.port).toBe(993);
    expect(acc!.protocol).toBe("imap");
    expect(acc!.tls).toBe("ssl");
  });

  test("хост и порт почты переопределяются", () => {
    process.env.MAILSENSE_MAIL_USER = "u";
    process.env.MAILSENSE_MAIL_PASS = "p";
    process.env.MAILSENSE_MAIL_HOST = "mail.company.local";
    process.env.MAILSENSE_MAIL_PORT = "143";
    const acc = loadConfig().defaultAccount!;
    expect(acc.host).toBe("mail.company.local");
    expect(acc.port).toBe(143);
  });
});

describe("адрес сервера документооборота", () => {
  test("пустая строка превращается в null", () => {
    process.env.MAILSENSE_DOCFLOW_URL = "";
    expect(loadConfig().docflowServerUrl).toBeNull();
    process.env.MAILSENSE_DOCFLOW_URL = "   ";
    expect(loadConfig().docflowServerUrl).toBeNull();
  });

  test("хвостовые слэши срезаются — иначе пути склеятся с двойным слэшем", () => {
    process.env.MAILSENSE_DOCFLOW_URL = "https://doc.company.local/";
    expect(loadConfig().docflowServerUrl).toBe("https://doc.company.local");
    process.env.MAILSENSE_DOCFLOW_URL = "https://doc.company.local///";
    expect(loadConfig().docflowServerUrl).toBe("https://doc.company.local");
  });

  test("обычный адрес сохраняется как есть", () => {
    process.env.MAILSENSE_DOCFLOW_URL = "http://192.168.1.10:8123";
    expect(loadConfig().docflowServerUrl).toBe("http://192.168.1.10:8123");
  });
});
