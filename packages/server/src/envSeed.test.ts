import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import {
  seedFromEnvironment,
  seedLdapFromEnv,
  seedServiceMailboxesFromEnv
} from "./envSeed.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Засев каталога и служебных ящиков из окружения (T51).
 *
 * Главное правило: настройка в БАЗЕ важнее переменной — перезапуск контейнера не должен
 * молча отменять решение администратора. И ни одна ошибка засева не роняет старт.
 */
const ENCRYPT = (plain: string) => "ШИФР:" + plain;

function db(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const writes: Array<[string, string]> = [];
  return {
    data,
    writes,
    readSetting: async (key: string) => data[key] ?? null,
    writeSetting: async (key: string, value: string) => {
      data[key] = value;
      writes.push([key, value]);
    }
  };
}

const ACCOUNTS = [
  { id: "acc-1", username: "test@mail.test" },
  { id: "acc-2", username: "manufactory@kaluga.net" }
];

const FULL_LDAP_ENV = {
  MAILSENSE_LDAP_URL: "ldaps://dc.stand.test:636",
  MAILSENSE_LDAP_BASE_DN: "DC=stand,DC=test",
  MAILSENSE_LDAP_LOGIN: "ldap-bind",
  MAILSENSE_LDAP_PASSWORD: "Секрет123!",
  MAILSENSE_LDAP_ENABLED: "true",
  MAILSENSE_LDAP_LOGIN_FORMAT: "upn",
  MAILSENSE_LDAP_UPN_SUFFIX: "@stand.test",
  MAILSENSE_LDAP_REJECT_UNAUTHORIZED: "false"
};

describe("каталог из переменных окружения", () => {
  test("пустое окружение — ничего не делаем и не пишем", async () => {
    const store = db();

    const result = await seedLdapFromEnv({ env: {}, ...store, encrypt: ENCRYPT });

    expect(result).toEqual({ written: [], skipped: [], warnings: [] });
    expect(store.writes).toEqual([]);
  });

  test("настройки записываются, пароль — зашифрованным (как из интерфейса)", async () => {
    const store = db();

    const result = await seedLdapFromEnv({ env: FULL_LDAP_ENV, ...store, encrypt: ENCRYPT });

    expect(store.data["ldap.url"]).toBe("ldaps://dc.stand.test:636");
    expect(store.data["ldap.baseDn"]).toBe("DC=stand,DC=test");
    expect(store.data["ldap.enabled"]).toBe("true");
    expect(store.data["ldap.login"]).toBe("ldap-bind");
    // ⚠️ В базе — только шифротекст: открытый пароль не попадает ни в настройки, ни в журнал.
    expect(store.data["ldap.passwordEncrypted"]).toBe("ШИФР:Секрет123!");
    expect(JSON.stringify(result)).not.toContain("Секрет123!");
    expect(result.written).toContain("Учётка каталога");
    expect(result.warnings).toEqual([]);
  });

  test("настройка, уже заданная администратором, НЕ перетирается", async () => {
    const store = db({ "ldap.url": "ldaps://admin-changed:636", "ldap.login": "admin-bind" });

    const result = await seedLdapFromEnv({ env: FULL_LDAP_ENV, ...store, encrypt: ENCRYPT });

    expect(store.data["ldap.url"]).toBe("ldaps://admin-changed:636");
    expect(store.data["ldap.login"]).toBe("admin-bind");
    expect(result.skipped).toContain("Адрес");
    expect(result.skipped).toContain("Учётка каталога");
    // Остальные значения из окружения всё равно записались.
    expect(store.data["ldap.baseDn"]).toBe("DC=stand,DC=test");
  });

  test("неполный набор переменных (нет Base DN) — предупреждение, а не падение", async () => {
    const store = db();

    const result = await seedLdapFromEnv({
      env: { MAILSENSE_LDAP_URL: "ldaps://dc.stand.test:636" },
      ...store,
      encrypt: ENCRYPT
    });

    expect(store.data["ldap.url"]).toBe("ldaps://dc.stand.test:636");
    expect(result.warnings.join(" ")).toContain("MAILSENSE_LDAP_BASE_DN");
  });

  test("пароль без логина — предупреждение, учётка не пишется", async () => {
    const store = db();

    const result = await seedLdapFromEnv({
      env: { MAILSENSE_LDAP_PASSWORD: "Секрет123!" },
      ...store,
      encrypt: ENCRYPT
    });

    expect(result.warnings.join(" ")).toContain("неполно");
    expect(store.data["ldap.passwordEncrypted"]).toBeUndefined();
    expect(store.data).not.toHaveProperty("ldap.login");
  });
});

describe("служебные ящики из переменных окружения", () => {
  const mailboxDeps = (store: ReturnType<typeof db>, env: Record<string, string>) => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      deps: {
        env,
        readSetting: store.readSetting,
        // В ядре поиск делает getAccountByUsername: регистр и краевые пробелы не важны.
        findAccount: (address: string) => {
          const wanted = address.trim().toLowerCase();
          return (ACCOUNTS.find((a) => a.username === wanted) ?? null) as never;
        },
        writeServiceAccounts: async (input: { internal?: string | null; external?: string | null }) => {
          calls.push(input);
        }
      }
    };
  };

  test("ящики находятся по адресу и записываются ролями", async () => {
    const store = db();
    const { deps, calls } = mailboxDeps(store, {
      // Адрес пришёл в другом регистре и с пробелом — ящик всё равно должен найтись.
      MAILSENSE_SERVICE_MAILBOX: "  TEST@MAIL.TEST ",
      MAILSENSE_EXTERNAL_MAILBOX: "manufactory@kaluga.net"
    });

    const result = await seedServiceMailboxesFromEnv(deps);

    expect(result.internal).toBe("written");
    expect(result.external).toBe("written");
    expect(calls).toEqual([{ internal: "acc-1", external: "acc-2" }]);
  });

  test("адрес не найден — строка в журнал, остальное работает", async () => {
    const store = db();
    const { deps, calls } = mailboxDeps(store, {
      MAILSENSE_SERVICE_MAILBOX: "test@mail.test",
      MAILSENSE_EXTERNAL_MAILBOX: "опечатка@нет-такого.test"
    });

    const result = await seedServiceMailboxesFromEnv(deps);

    expect(result.internal).toBe("written");
    expect(result.external).toBe("not_found");
    expect(result.warnings.join(" ")).toContain("опечатка@нет-такого.test");
    expect(calls).toEqual([{ internal: "acc-1" }]);
  });

  test("уже заданная роль не перетирается", async () => {
    const store = db({ "docflow.serviceAccountId": "acc-existing" });
    const { deps, calls } = mailboxDeps(store, { MAILSENSE_SERVICE_MAILBOX: "test@mail.test" });

    const result = await seedServiceMailboxesFromEnv(deps);

    expect(result.internal).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("внешняя роль совпала с внутренней — предупреждение (пилот), но запись есть", async () => {
    const store = db();
    const { deps, calls } = mailboxDeps(store, {
      MAILSENSE_SERVICE_MAILBOX: "test@mail.test",
      MAILSENSE_EXTERNAL_MAILBOX: "test@mail.test"
    });

    const result = await seedServiceMailboxesFromEnv(deps);

    expect(calls).toEqual([{ internal: "acc-1", external: "acc-1" }]);
    expect(result.warnings.join(" ")).toContain("пилот");
  });

  test("второй запуск идемпотентен: ничего не пишется повторно", async () => {
    const store = db();
    const first = mailboxDeps(store, { MAILSENSE_SERVICE_MAILBOX: "test@mail.test" });
    await seedServiceMailboxesFromEnv(first.deps);

    // Первый запуск записал значения — теперь они есть в базе.
    store.data["docflow.serviceAccountId"] = "acc-1";
    const second = mailboxDeps(store, { MAILSENSE_SERVICE_MAILBOX: "test@mail.test" });
    const result = await seedServiceMailboxesFromEnv(second.deps);

    expect(result.internal).toBe("skipped");
    expect(second.calls).toEqual([]);
  });
});

describe("засев целиком: старт не падает ни при каких ошибках", () => {
  test("одна строка в журнал со сводкой", async () => {
    const store = db();
    const summary = (
      await seedFromEnvironment({
        env: {
          MAILSENSE_LDAP_URL: "ldaps://dc.stand.test:636",
          MAILSENSE_LDAP_BASE_DN: "DC=stand,DC=test",
          MAILSENSE_SERVICE_MAILBOX: "test@mail.test"
        },
        ...store,
        encrypt: ENCRYPT,
        findAccount: (address: string) => (ACCOUNTS.find((a) => a.username === address.trim().toLowerCase()) ?? null) as never,
        writeServiceAccounts: async () => undefined
      })
    ).summary;

    expect(summary).toContain("Засев из окружения");
    expect(summary).toContain("каталог: записано");
    expect(summary).toContain("ящики: внутренний настроен");
    // Сводка ядра про засев ящиков — в той же строке, чтобы не искать по журналу.
    expect(
      (
        await seedFromEnvironment({
          env: {},
          readSetting: async () => null,
          writeSetting: async () => undefined,
          mailboxSeed: { created: 2, skipped: 0, failed: 0 }
        })
      ).summary
    ).toContain("ящики ядра: создано 2");
  });

  test("сбой записи настройки каталога не роняет старт: причина в строке журнала", async () => {
    const outcome = await seedFromEnvironment({
      env: { MAILSENSE_LDAP_URL: "ldaps://dc.stand.test:636" },
      readSetting: async () => null,
      writeSetting: async () => {
        throw new Error("база недоступна");
      },
      encrypt: ENCRYPT
    });

    expect(outcome.error).toContain("база недоступна");
    expect(outcome.summary).toContain("НЕ УДАЛОСЬ");
    expect(outcome.summary).toContain("каталог");
  });

  test("сбой ящиков не мешает каталогу и не роняет старт", async () => {
    const store = db();
    const outcome = await seedFromEnvironment({
      env: {
        MAILSENSE_LDAP_URL: "ldaps://dc.stand.test:636",
        MAILSENSE_LDAP_BASE_DN: "DC=stand,DC=test",
        MAILSENSE_SERVICE_MAILBOX: "test@mail.test"
      },
      ...store,
      encrypt: ENCRYPT,
      findAccount: () => {
        throw new Error("почтовая база не открылась");
      }
    });

    expect(outcome.ldap?.written.length).toBeGreaterThan(0);
    expect(outcome.mailboxes).toBeNull();
    expect(outcome.error).toContain("почтовая база не открылась");
  });
});
