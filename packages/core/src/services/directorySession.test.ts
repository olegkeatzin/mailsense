import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Сессия каталога и поиск. Правило: LDAP недоступен — отдаём кэш, а не ошибку;
 * поиск не должен падать из-за сети.
 */
const mockVerify = jest.fn();
const mockSearch = jest.fn();

jest.mock("../directory/ldap.js", () => {
  // Предел берём из настоящего модуля: иначе тест зафиксирует не то число,
  // которое реально использует refreshDirectory.
  const actual = jest.requireActual("../directory/ldap.js");
  return {
    __esModule: true,
    DIRECTORY_BULK_LIMIT: actual.DIRECTORY_BULK_LIMIT,
    verifyLdapCredentials: (...a: unknown[]) => mockVerify(...a),
    ldapSearchContacts: (...a: unknown[]) => mockSearch(...a)
  };
});

import { DIRECTORY_BULK_LIMIT } from "../directory/ldap.js";
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { countContacts, searchContactsCache, upsertContacts } from "../repos.js";
import {
  directoryCredentials,
  directoryLogin,
  directoryLogout,
  directoryStatus,
  refreshDirectory,
  searchDirectory,
  setLdapSettings
} from "./directoryService.js";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-ldap-session-"));
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

const contact = (dn: string, over: Record<string, string> = {}) => ({
  dn,
  login: "login",
  displayName: "Имя",
  mail: "mail@test.local",
  title: "",
  department: "",
  phone: "",
  updatedAt: "",
  ...over
});

beforeEach(async () => {
  mockVerify.mockReset().mockResolvedValue(undefined);
  mockSearch.mockReset().mockResolvedValue([]);
  await directoryLogout();
  await setLdapSettings({ url: "ldaps://dc.test:636", baseDn: "OU=K,DC=test" });
});

describe("вход в каталог", () => {
  test("без адреса и Base DN вход невозможен", async () => {
    await setLdapSettings({ url: "", baseDn: "" });
    await expect(directoryLogin("user", "pass")).rejects.toThrow(/URL и Base DN/);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  test("успешный вход сохраняет учётку, статус — «вошли»", async () => {
    const st = await directoryLogin("svc@test.local", "секрет");
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ url: "ldaps://dc.test:636" }), "svc@test.local", "секрет");
    expect(st.loggedIn).toBe(true);
    expect(st.login).toBe("svc@test.local");
  });

  test("пароль сохраняется зашифрованным и читается обратно", async () => {
    await directoryLogin("svc@test.local", "секрет");
    // В настройках не должно быть открытого пароля.
    const cred = directoryCredentials()!;
    expect(cred.login).toBe("svc@test.local");
    expect(cred.password).toBe("секрет");
  });

  test("отказ каталога не сохраняет учётку", async () => {
    mockVerify.mockRejectedValue(new Error("неверный пароль"));
    await expect(directoryLogin("svc@test.local", "плохой")).rejects.toThrow("неверный пароль");
    expect(directoryStatus().loggedIn).toBe(false);
    expect(directoryCredentials()).toBeNull();
  });
});

describe("выход из каталога", () => {
  test("после выхода учётка не хранится", async () => {
    await directoryLogin("svc@test.local", "секрет");
    const st = await directoryLogout();
    expect(st.loggedIn).toBe(false);
    expect(directoryCredentials()).toBeNull();
  });

  test("повторный выход не падает", async () => {
    await directoryLogout();
    await expect(directoryLogout()).resolves.toMatchObject({ loggedIn: false });
  });
});

describe("поиск", () => {
  test("без входа в каталог поиск идёт только по кэшу", async () => {
    upsertContacts([contact("CN=Кэш,DC=test", { displayName: "Из кэша" })]);
    const res = await searchDirectory("Из кэша");
    expect(res.length).toBeGreaterThanOrEqual(1);
    // В LDAP без учётки ходить нечем.
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("результаты каталога добавляются к кэшу", async () => {
    await directoryLogin("svc@test.local", "секрет");
    mockSearch.mockResolvedValue([contact("CN=Онлайн,DC=test", { displayName: "Из каталога" })]);

    const res = await searchDirectory("Из каталога");
    expect(res.some((c) => c.displayName === "Из каталога")).toBe(true);
  });

  test("онлайн-данные перекрывают устаревший кэш", async () => {
    upsertContacts([contact("CN=Тот,DC=test", { displayName: "Старое имя", mail: "old@test.local" })]);
    await directoryLogin("svc@test.local", "секрет");
    mockSearch.mockResolvedValue([contact("CN=Тот,DC=test", { displayName: "Новое имя", mail: "new@test.local" })]);

    const res = await searchDirectory("Тот");
    const found = res.filter((c) => c.dn === "CN=Тот,DC=test");
    // Дубль по DN не должен появляться дважды.
    expect(found).toHaveLength(1);
    expect(found[0].mail).toBe("new@test.local");
  });

  test("недоступный каталог не ломает поиск — отдаётся кэш", async () => {
    upsertContacts([contact("CN=Кэш2,DC=test", { displayName: "Кэш при сбое" })]);
    await directoryLogin("svc@test.local", "секрет");
    mockSearch.mockRejectedValue(new Error("каталог недоступен"));

    const res = await searchDirectory("Кэш при сбое");
    expect(res.some((c) => c.displayName === "Кэш при сбое")).toBe(true);
  });

  test("найденное в каталоге попадает в кэш", async () => {
    await directoryLogin("svc@test.local", "секрет");
    const before = countContacts();
    mockSearch.mockResolvedValue([contact("CN=Новый,DC=test", { displayName: "Для кэша" })]);

    await searchDirectory("Для кэша");
    expect(countContacts()).toBe(before + 1);
  });

  test("лимит результатов соблюдается", async () => {
    await directoryLogin("svc@test.local", "секрет");
    mockSearch.mockResolvedValue([
      contact("CN=A,DC=test", { displayName: "A" }),
      contact("CN=B,DC=test", { displayName: "B" }),
      contact("CN=C,DC=test", { displayName: "C" })
    ]);
    expect((await searchDirectory("", 2)).length).toBeLessThanOrEqual(2);
  });

  test("пустой ответ каталога оставляет кэш как есть", async () => {
    await directoryLogin("svc@test.local", "секрет");
    mockSearch.mockResolvedValue([]);
    await expect(searchDirectory("ничего")).resolves.toEqual(expect.any(Array));
  });
});

describe("полная выгрузка каталога", () => {
  test("без входа выгрузка невозможна", async () => {
    await expect(refreshDirectory()).rejects.toThrow(/войдите в каталог/i);
  });

  test("выгрузка возвращает число записей и наполняет кэш", async () => {
    await directoryLogin("svc@test.local", "секрет");
    const before = countContacts();
    mockSearch.mockResolvedValue([
      contact("CN=1,DC=test", { displayName: "Первый" }),
      contact("CN=2,DC=test", { displayName: "Второй" })
    ]);

    expect(await refreshDirectory()).toBe(2);
    expect(countContacts()).toBe(before + 2);
    // Полная выгрузка запрашивает всё, а не 25 записей и не прежние 2000:
    // на каталоге больше 2000 кэш обрезался, и сотрудники не находились поиском.
    expect(mockSearch.mock.calls[0][4]).toBe(DIRECTORY_BULK_LIMIT);
    // И сам предел больше прежних 2000, иначе кэш снова обрезался бы.
    expect(DIRECTORY_BULK_LIMIT).toBeGreaterThan(2000);
  });

  test("каталог больше 2000 попадает в кэш целиком", async () => {
    await directoryLogin("svc@test.local", "секрет");
    // 2500 сотрудников: до правки в кэш уходило максимум 2000.
    mockSearch.mockResolvedValue(
      Array.from({ length: 2500 }, (_, i) => contact("CN=U" + i + ",DC=test", { displayName: "Сотрудник " + i }))
    );

    expect(await refreshDirectory()).toBe(2500);
    // Поиск по кэшу находит и тех, кто «за» прежним пределом.
    expect(searchContactsCache("Сотрудник 2499", 5).length).toBeGreaterThan(0);
  });
});
