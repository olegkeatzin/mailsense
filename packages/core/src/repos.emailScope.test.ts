import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Фильтр писем по ЯЩИКАМ: у СЭД своя почта (служебные ящики + личный рабочий),
 * и очередь аппарата не должна показывать письма посторонних ящиков.
 * Второй реализации фильтра быть не должно — состав разрешённых ящиков считает сервер,
 * а сюда приходит готовый список accountIds.
 */
import { initApp } from "./init.js";
import { closeDb } from "./db/index.js";
import { insertAccount, insertEmail, listEmailsWithAnalysis } from "./repos.js";

let dir = "";
let accA = "";
let accB = "";
let accC = "";

function account(username: string): string {
  return insertAccount(
    { protocol: "imap", host: "mail.test", port: 993, tls: "ssl", username, password: "p", authType: "login" },
    "enc"
  ).id;
}

function email(accountId: string, uid: string): void {
  insertEmail({
    accountId,
    folder: "INBOX",
    uid,
    messageId: uid + "@test.local",
    subject: "Письмо " + uid,
    from: { address: "sender@test.local" },
    to: [{ address: "me@test.local" }],
    cc: [],
    replyTo: null,
    inReplyTo: null,
    references: [],
    date: "2026-10-01T10:00:00.000Z",
    bodyText: "тело",
    bodyHtml: null,
    headers: { subject: "Письмо" }
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-email-scope-"));
  initApp({ dataDir: dir });
  accA = account("service@mail.test");
  accB = account("external@mail.test");
  accC = account("yandex@yandex.test"); // обычный внешний ящик — в СЭД не участвует
  email(accA, "a-1");
  email(accA, "a-2");
  email(accB, "b-1");
  email(accC, "c-1");
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("фильтр по одному ящику (как было)", () => {
  test("accountId отбирает письма только этого ящика", () => {
    expect(listEmailsWithAnalysis({ accountId: accA })).toHaveLength(2);
    expect(listEmailsWithAnalysis({ accountId: accC })).toHaveLength(1);
  });

  test("без фильтра видно все ящики (прежнее поведение не меняем)", () => {
    expect(listEmailsWithAnalysis({})).toHaveLength(4);
  });
});

describe("фильтр по списку ящиков", () => {
  test("accountIds отбирает письма перечисленных ящиков", () => {
    expect(listEmailsWithAnalysis({ accountIds: [accA, accB] })).toHaveLength(3);
    expect(listEmailsWithAnalysis({ accountIds: [accA] })).toHaveLength(2);
  });

  test("посторонний ящик в список не попал — его письма не видны", () => {
    const rows = listEmailsWithAnalysis({ accountIds: [accA, accB] });
    expect(rows.map((r) => r.accountId)).not.toContain(accC);
  });

  test("пустой список — пустая очередь, а не «все ящики»", () => {
    expect(listEmailsWithAnalysis({ accountIds: [] })).toEqual([]);
  });

  test("пустые строки и пробелы в списке не превращаются во «все ящики»", () => {
    expect(listEmailsWithAnalysis({ accountIds: ["", "   "] })).toEqual([]);
    expect(listEmailsWithAnalysis({ accountIds: ["  " + accA + "  "] })).toHaveLength(2);
  });

  test("несуществующий ящик ничего не возвращает", () => {
    expect(listEmailsWithAnalysis({ accountIds: ["нет-такого-ящика"] })).toEqual([]);
  });

  test("accountIds важнее одиночного accountId", () => {
    // Список — новый способ; если пришли оба, доверяем списку (иначе фильтр был бы непредсказуем).
    expect(listEmailsWithAnalysis({ accountId: accA, accountIds: [accB] })).toHaveLength(1);
  });
});
