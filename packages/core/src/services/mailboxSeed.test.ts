import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Засев ящиков из окружения (MAILSENSE_MAILBOXES): контейнер разворачивается целиком
 * из .env, без захода в интерфейс. Ящик создаётся только если его ещё нет — пароль,
 * изменённый в интерфейсе, перезаписывать нельзя. Один плохой элемент не роняет остальные.
 */
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { getAccountByUsername, listAccounts } from "../repos.js";
import { loadConfig, parseMailboxes, type Config, type MailboxConfig } from "../config.js";
import { seedMailboxes } from "./mailboxSeed.js";

let dir = "";

function mailbox(over: Partial<MailboxConfig> = {}): MailboxConfig {
  return {
    username: "post@mail.test",
    password: "секрет",
    protocol: "imap",
    host: "mail.test",
    port: 993,
    tls: "ssl",
    authType: "login",
    ...over
  };
}

/** Свежий стенд: своя папка данных и свой ключ шифрования. */
function freshApp(over: Partial<Config> = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-mailbox-seed-"));
  const app = initApp({ dataDir: dir, ...over });
  return app;
}

afterEach(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("засев из списка", () => {
  test("IMAP и POP3 создаются, пароли шифруются, SMTP-поля сохраняются", () => {
    const app = freshApp({
      mailboxes: [
        mailbox({
          username: "post@mail.test",
          smtpHost: "smtp.test",
          smtpPort: 465,
          smtpTls: "ssl",
          smtpUsername: "post@mail.test",
          smtpPassword: "smtp-секрет"
        }),
        mailbox({ username: "pop3@mail.test", protocol: "pop3", port: 995 })
      ],
      mailboxErrors: []
    });

    // Засев уже выполнен внутри initApp — сводка оттуда и есть.
    expect(app.mailboxSeed).toEqual({ created: 2, skipped: 0, failed: 0 });

    const imap = getAccountByUsername("post@mail.test")!;
    expect(imap.protocol).toBe("imap");
    expect(imap.port).toBe(993);
    expect(imap.tls).toBe("ssl");
    expect(imap.smtpHost).toBe("smtp.test");
    expect(imap.smtpPort).toBe(465);
    expect(imap.smtpTls).toBe("ssl");
    // В базе лежит ШИФР, а не открытый пароль (и он расшифровывается тем же ключом).
    expect(imap.passwordEncrypted).not.toContain("секрет");
    expect(app.secrets.decrypt(imap.passwordEncrypted)).toBe("секрет");
    expect(app.secrets.decrypt(imap.smtpPasswordEncrypted!)).toBe("smtp-секрет");

    const pop3 = getAccountByUsername("pop3@mail.test")!;
    expect(pop3.protocol).toBe("pop3");
    expect(pop3.port).toBe(995);
  });

  test("повторный запуск идемпотентен: ничего не дублируется", () => {
    const app = freshApp({ mailboxes: [mailbox()], mailboxErrors: [] });

    expect(app.mailboxSeed).toEqual({ created: 1, skipped: 0, failed: 0 });
    // Повторный запуск (перезапуск контейнера): ничего не создаётся и не дублируется.
    expect(seedMailboxes(app.config, app.secrets)).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(listAccounts()).toHaveLength(1);
  });

  test("существующий ящик НЕ перезаписывается (пароль из интерфейса важнее)", () => {
    const app = freshApp({ mailboxes: [mailbox({ password: "первый" })], mailboxErrors: [] });
    expect(app.mailboxSeed.created).toBe(1);

    const second = { ...app.config, mailboxes: [mailbox({ password: "второй" })] };
    expect(seedMailboxes(second, app.secrets)).toEqual({ created: 0, skipped: 1, failed: 0 });

    const acc = getAccountByUsername("post@mail.test")!;
    expect(app.secrets.decrypt(acc.passwordEncrypted)).toBe("первый");
  });

  test("регистр в адресе не создаёт второй ящик", () => {
    const app = freshApp({ mailboxes: [mailbox({ username: "Post@Mail.Test" })], mailboxErrors: [] });
    expect(app.mailboxSeed.created).toBe(1);

    const second = { ...app.config, mailboxes: [mailbox({ username: "post@mail.test" })] };
    const report = seedMailboxes(second, app.secrets);
    expect(report).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(listAccounts()).toHaveLength(1);
  });

  test("плохой элемент не роняет остальные: остальные создаются", () => {
    const app = freshApp({
      mailboxes: [mailbox(), mailbox({ username: "second@mail.test" })],
      mailboxErrors: ["ящик #2: неизвестный протокол «smtp»"]
    });

    // Два ящика созданы, третий (битый элемент из переменной) — только в счётчике отказов.
    expect(app.mailboxSeed).toEqual({ created: 2, skipped: 0, failed: 1 });
    expect(listAccounts()).toHaveLength(2);
  });

  test("предупреждения о полях не попадают в отказы и не мешают засеву", () => {
    const app = freshApp({
      mailboxes: [mailbox()],
      mailboxErrors: [],
      mailboxWarnings: ["ящик #1 (post@mail.test): неизвестные поля smtpPortt — пропущены"]
    });

    // Ящик создан, отказов нет: предупреждение — не ошибка (в журнал пишет отдельный тест).
    expect(app.mailboxSeed).toEqual({ created: 1, skipped: 0, failed: 0 });
  });

  test("сбой на одном ящике не мешает создать следующий", () => {
    const app = freshApp({
      mailboxes: [
        // Пустой адрес ядро не примет — этот ящик должен попасть в failed, а не уронить засев.
        mailbox({ username: "   " }),
        mailbox({ username: "alive@mail.test" })
      ],
      mailboxErrors: []
    });

    expect(app.mailboxSeed.created).toBe(1);
    expect(app.mailboxSeed.failed).toBe(1);
    expect(getAccountByUsername("alive@mail.test")).not.toBeNull();
  });
});

describe("засев целиком из окружения", () => {
  test("MAILSENSE_MAILBOXES работает через loadConfig (как в контейнере)", () => {
    process.env.MAILSENSE_MAILBOXES = JSON.stringify([
      { username: "env@mail.test", password: "p", protocol: "imap", host: "mail.test", port: 993, tls: true }
    ]);
    try {
      const app = freshApp();
      expect(app.config.mailboxes).toHaveLength(1);
      expect(app.mailboxSeed).toEqual({ created: 1, skipped: 0, failed: 0 });
      expect(getAccountByUsername("ENV@MAIL.TEST")).not.toBeNull();
      // Ящиков ровно один: одиночный засев (MAILSENSE_SEED_ACCOUNT) не включён.
      expect(listAccounts()).toHaveLength(1);
    } finally {
      delete process.env.MAILSENSE_MAILBOXES;
    }
  });

  test("одиночный MAILSENSE_SEED_ACCOUNT продолжает работать вместе со списком", () => {
    const app = freshApp({
      seedAccount: true,
      defaultAccount: {
        protocol: "imap",
        host: "stand.test",
        port: 993,
        tls: "ssl",
        username: "single@mail.test",
        password: "одиночный",
        authType: "login"
      },
      mailboxes: [mailbox({ username: "fromlist@mail.test" })],
      mailboxErrors: []
    });

    // Одиночный засеялся первым, затем список — обе записи на месте.
    expect(getAccountByUsername("single@mail.test")).not.toBeNull();
    expect(app.mailboxSeed).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(listAccounts()).toHaveLength(2);
  });
});

describe("поиск ящика по адресу", () => {
  test("находит без учёта регистра и краевых пробелов", () => {
    const app = freshApp({ mailboxes: [mailbox()], mailboxErrors: [] });
    seedMailboxes(app.config, app.secrets);

    expect(getAccountByUsername("post@mail.test")?.username).toBe("post@mail.test");
    expect(getAccountByUsername("POST@MAIL.TEST")?.username).toBe("post@mail.test");
    expect(getAccountByUsername("  post@mail.test  ")?.username).toBe("post@mail.test");
  });

  test("несуществующий и пустой адрес дают null, а не ошибку", () => {
    freshApp();
    expect(getAccountByUsername("нет-такого@mail.test")).toBeNull();
    expect(getAccountByUsername("")).toBeNull();
    expect(getAccountByUsername("   ")).toBeNull();
  });
});
