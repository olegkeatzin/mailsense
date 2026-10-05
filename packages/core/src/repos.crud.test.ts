import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Репозитории: разделы, которые ещё не были покрыты — темы переписок, черновики,
 * шаблоны, кэш каталога. Это «память» приложения, и потеря данных здесь тихая.
 */
import { initApp } from "./init.js";
import { closeDb } from "./db/index.js";
import {
  countContacts,
  createThread,
  deleteDraft,
  deleteTemplate,
  findThreadByRoot,
  getDraft,
  getTemplate,
  getThread,
  insertAccount,
  insertDraft,
  insertTemplate,
  listAccountIds,
  listContacts,
  listDrafts,
  listTemplates,
  searchContactsCache,
  touchThread,
  updateDraft,
  updateTemplate,
  upsertContacts
} from "./repos.js";
import { NodeSecretStore } from "./secrets.js";

let dir = "";
let accountId = "";
let otherAccountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-repos-"));
  initApp({ dataDir: dir });
  const secrets = new NodeSecretStore(dir);
  const base = {
    protocol: "imap" as const,
    host: "mail.test",
    port: 993,
    tls: "ssl" as const,
    authType: "login" as const,
    password: "p"
  };
  accountId = insertAccount({ ...base, username: "one@mail.test" }, secrets.encrypt("p")).id;
  otherAccountId = insertAccount({ ...base, username: "two@mail.test" }, secrets.encrypt("p")).id;
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("список аккаунтов", () => {
  test("возвращаются идентификаторы созданных аккаунтов", () => {
    const ids = listAccountIds();
    expect(ids).toContain(accountId);
    expect(ids).toContain(otherAccountId);
  });
});

describe("темы переписок", () => {
  test("созданная тема читается по идентификатору", () => {
    const t = createThread(accountId, "root@test.local", "тема письма");
    expect(t.accountId).toBe(accountId);
    expect(t.rootMessageId).toBe("root@test.local");
    expect(getThread(t.id)!.normalizedSubject).toBe("тема письма");
  });

  test("поиск по корневому письму идёт в пределах аккаунта", () => {
    const t = createThread(accountId, "unique-root@test.local", "тема");
    expect(findThreadByRoot(accountId, "unique-root@test.local")!.id).toBe(t.id);
    // Одинаковые Message-ID в разных ящиках — разные переписки.
    expect(findThreadByRoot(otherAccountId, "unique-root@test.local")).toBeNull();
  });

  test("несуществующая тема даёт null", () => {
    expect(getThread("нет-такой")).toBeNull();
    expect(findThreadByRoot(accountId, "нет-такого")).toBeNull();
  });

  test("время последнего письма двигается только вперёд", () => {
    const t = createThread(accountId, "touch@test.local", "тема");
    // Тема создана «сейчас», поэтому берём заведомо будущую дату.
    touchThread(t.id, "2030-01-01T10:00:00.000Z");
    expect(getThread(t.id)!.lastMessageAt).toBe("2030-01-01T10:00:00.000Z");

    // Более старое письмо не должно «омолаживать» тему — иначе она уедет вниз списка.
    touchThread(t.id, "2020-01-01T10:00:00.000Z");
    expect(getThread(t.id)!.lastMessageAt).toBe("2030-01-01T10:00:00.000Z");
  });

  test("касание несуществующей темы не падает", () => {
    expect(() => touchThread("нет-такой", "2026-01-01T00:00:00.000Z")).not.toThrow();
  });
});

describe("черновики", () => {
  test("черновик сохраняется со всеми полями", () => {
    const d = insertDraft({
      accountId,
      to: [{ name: "Клиент", address: "client@test.local" }],
      cc: [{ address: "cc@test.local" }],
      subject: "Черновик",
      bodyText: "текст",
      bodyHtml: "<p>текст</p>",
      attachments: [{ filename: "файл.txt", mimeType: "text/plain", data: "AAA" }],
      references: ["root@test.local"]
    });
    const saved = getDraft(d.id)!;
    expect(saved.subject).toBe("Черновик");
    expect(saved.to[0].address).toBe("client@test.local");
    expect(saved.cc).toHaveLength(1);
    expect(saved.attachments[0].filename).toBe("файл.txt");
    expect(saved.references).toEqual(["root@test.local"]);
  });

  test("пустые списки сохраняются как пустые, а не как null", () => {
    const d = insertDraft({ accountId, to: [], subject: "Пустой", bodyText: "" });
    const saved = getDraft(d.id)!;
    expect(saved.to).toEqual([]);
    expect(saved.cc).toEqual([]);
    expect(saved.attachments).toEqual([]);
  });

  test("частичное обновление не затирает остальные поля", () => {
    const d = insertDraft({ accountId, to: [], subject: "Старое", bodyText: "старое тело" });
    const updated = updateDraft(d.id, { subject: "Новое" })!;
    expect(updated.subject).toBe("Новое");
    expect(updated.bodyText).toBe("старое тело");
  });

  test("обновление несуществующего черновика даёт null", () => {
    expect(updateDraft("нет-такого", { subject: "x" })).toBeNull();
  });

  test("список фильтруется по аккаунту", () => {
    insertDraft({ accountId: otherAccountId, to: [], subject: "Чужой", bodyText: "" });
    const mine = listDrafts(accountId);
    expect(mine.every((d) => d.accountId === accountId)).toBe(true);
    expect(mine.some((d) => d.subject === "Чужой")).toBe(false);
    expect(listDrafts().some((d) => d.subject === "Чужой")).toBe(true);
  });

  test("удаление убирает черновик", () => {
    const d = insertDraft({ accountId, to: [], subject: "На удаление", bodyText: "" });
    deleteDraft(d.id);
    expect(getDraft(d.id)).toBeNull();
  });
});

describe("шаблоны писем", () => {
  test("шаблон сохраняется с значениями по умолчанию", () => {
    const t = insertTemplate({ name: "Заготовка" });
    expect(t.subject).toBe("");
    expect(t.bodyText).toBe("");
    expect(t.accountId).toBeNull();
  });

  test("в список аккаунта попадают общие шаблоны и его собственные", () => {
    insertTemplate({ name: "Общий" });
    insertTemplate({ name: "Свой", accountId });
    insertTemplate({ name: "Чужой", accountId: otherAccountId });

    const names = listTemplates(accountId).map((t) => t.name);
    expect(names).toContain("Общий");
    expect(names).toContain("Свой");
    // Шаблоны другого ящика не должны показываться.
    expect(names).not.toContain("Чужой");
  });

  test("список отсортирован по имени", () => {
    const names = listTemplates().map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "ru"));
    expect(names).toEqual(sorted);
  });

  test("частичное обновление сохраняет остальные поля", () => {
    const t = insertTemplate({ name: "Правка", subject: "Тема", bodyText: "тело" });
    const updated = updateTemplate(t.id, { subject: "Новая тема" })!;
    expect(updated.subject).toBe("Новая тема");
    expect(updated.bodyText).toBe("тело");
    expect(updated.name).toBe("Правка");
  });

  test("обновление несуществующего шаблона даёт null", () => {
    expect(updateTemplate("нет-такого", { name: "x" })).toBeNull();
  });

  test("удаление убирает шаблон", () => {
    const t = insertTemplate({ name: "На удаление" });
    deleteTemplate(t.id);
    expect(getTemplate(t.id)).toBeNull();
  });
});

describe("кэш каталога", () => {
  const contact = (dn: string, over: Record<string, string> = {}) => ({
    dn,
    login: "ivanov",
    displayName: "Иван Иванов",
    mail: "ivanov@test.local",
    title: "Инженер",
    department: "ИТ",
    phone: "123",
    updatedAt: "",
    ...over
  });

  test("контакты добавляются и находятся по имени", () => {
    upsertContacts([contact("CN=Иван,DC=test")]);
    expect(countContacts()).toBeGreaterThanOrEqual(1);
    expect(searchContactsCache("Иван").length).toBeGreaterThanOrEqual(1);
  });

  test("повторный upsert обновляет, а не дублирует (по DN)", () => {
    upsertContacts([contact("CN=Дубль,DC=test", { displayName: "Первый вариант" })]);
    const before = countContacts();
    upsertContacts([contact("CN=Дубль,DC=test", { displayName: "Обновлённый" })]);
    expect(countContacts()).toBe(before);

    const found = searchContactsCache("Обновлённый");
    expect(found[0].displayName).toBe("Обновлённый");
  });

  test("поиск идёт по почте, логину и отделу", () => {
    upsertContacts([contact("CN=Поиск,DC=test", { mail: "unique-mail@test.local", login: "unique_login", department: "Бухгалтерия" })]);
    expect(searchContactsCache("unique-mail").length).toBeGreaterThanOrEqual(1);
    expect(searchContactsCache("unique_login").length).toBeGreaterThanOrEqual(1);
    expect(searchContactsCache("Бухгалтерия").length).toBeGreaterThanOrEqual(1);
  });

  test("пустой запрос возвращает всё в пределах лимита", () => {
    const all = searchContactsCache("", 2);
    expect(all.length).toBeLessThanOrEqual(2);
  });

  test("лимит списка соблюдается", () => {
    expect(listContacts(1)).toHaveLength(1);
  });

  test("пустой список не создаёт записей", () => {
    const before = countContacts();
    upsertContacts([]);
    expect(countContacts()).toBe(before);
  });
});
