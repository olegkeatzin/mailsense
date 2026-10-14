import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ящик принадлежит человеку (docs/design/mail-ownership.md).
 *
 * ⚠️ Раньше маршруты отдавали всю таблицу accounts: в серверном режиме чужую почту можно
 * было читать по accountId, а чужой ящик — удалить. Здесь проверяем границу на уровне ядра:
 * чужой ящик для работника не существует.
 */
import { initApp } from "../init.js";
import { closeDb, getDb } from "../db/index.js";
import { accounts } from "../db/schema.js";
import { createAccount, getAccounts } from "./accountService.js";
import { getAccountForUser, listAccountsForUser } from "../repos.js";
import type { AccountInput } from "../types.js";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-owner-"));
  initApp({ dataDir: dir });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

function input(username: string, over: Partial<AccountInput> = {}): AccountInput {
  return {
    protocol: "pop3",
    host: "192.168.1.10",
    port: 995,
    tls: "ssl",
    username,
    password: "почтовый-пароль",
    authType: "login",
    ...over
  };
}

describe("владение ящиком", () => {
  test("ящик виден только владельцу", () => {
    createAccount(input("lisenko_od@kniitmu.ru"), "Лысенко_ОД");
    createAccount(input("petrova_ma@kniitmu.ru"), "Петрова_МА");

    expect(listAccountsForUser("Лысенко_ОД").map((a) => a.username)).toEqual(["lisenko_od@kniitmu.ru"]);
    expect(listAccountsForUser("Петрова_МА").map((a) => a.username)).toEqual(["petrova_ma@kniitmu.ru"]);
    expect(listAccountsForUser("Чужой_ЧЧ")).toEqual([]);
    // Общая таблица содержит оба ящика: доступ режется на выборке, а не «магией» в базе.
    expect(getAccounts()).toHaveLength(2);
  });

  test("чужой ящик не выдаётся по id", () => {
    const own = createAccount(input("ivanov_ii@kniitmu.ru"), "Иванов_ИИ");
    expect(getAccountForUser(own.id, "Иванов_ИИ")?.id).toBe(own.id);
    expect(getAccountForUser(own.id, "Петрова_МА")).toBeNull();
  });

  test("ящик без владельца не виден работникам (записи до появления владельца)", () => {
    const legacy = createAccount(input("old@kniitmu.ru"));
    expect(listAccountsForUser("Иванов_ИИ").some((a) => a.id === legacy.id)).toBe(false);
    expect(getAccountForUser(legacy.id, "Иванов_ИИ")).toBeNull();
  });

  test("владелец записан в базу, а не только в ответе", () => {
    createAccount(input("sidorov@kniitmu.ru"), "Сидоров_СС");
    const row = getDb()
      .select()
      .from(accounts)
      .all()
      .find((r) => r.username === "sidorov@kniitmu.ru");
    expect(row?.ownerUserId).toBe("Сидоров_СС");
  });

  test("владелец — это работник, а не ящик: несколько ящиков, в том числе на другом сервере", () => {
    createAccount(input("ivanov_ii@kniitmu.ru", { host: "10.168.101.3" }), "Иванов_ИИ");
    const mine = listAccountsForUser("Иванов_ИИ");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((a) => a.ownerUserId === "Иванов_ИИ")).toBe(true);
  });
});
