import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Связь «поручение → письмо в ящике исполнителя».
 *
 * Поручение отправляет аппарат, а исполнитель получает КОПИЮ письма с тем же Message-ID.
 * Поиск обязан ограничиваться ящиками спрашивающего: чужое письмо находить нельзя.
 */
import { initApp } from "./init.js";
import { closeDb } from "./db/index.js";
import { findEmailCopy, insertAccount, insertEmail } from "./repos.js";

let dir = "";
let accA = "";
let accB = "";

function account(username: string): string {
  return insertAccount(
    { protocol: "imap", host: "mail.test", port: 993, tls: "ssl", username, password: "p", authType: "login" },
    "enc"
  ).id;
}

function email(accountId: string, messageId: string, folder = "INBOX"): void {
  insertEmail({
    accountId,
    folder,
    uid: messageId,
    messageId,
    subject: "Поручение",
    from: { address: "apparat@test.local" },
    to: [{ address: "executor@test.local" }],
    cc: [],
    replyTo: null,
    inReplyTo: null,
    references: [],
    date: "2026-10-20T10:00:00.000Z",
    bodyText: "текст",
    bodyHtml: null,
    headers: {}
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-msgid-"));
  initApp({ dataDir: dir });
  accA = account("executor@test.local");
  accB = account("other@test.local");
});

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("письмо по Message-ID", () => {
  it("находит копию в своём ящике", () => {
    email(accA, "dispatch-1@mailsense.local");
    expect(findEmailCopy("dispatch-1@mailsense.local", [accA])).toMatchObject({
      accountId: accA,
      folder: "INBOX"
    });
  });

  it("чужой ящик не отдаёт письмо", () => {
    email(accB, "dispatch-2@mailsense.local");
    expect(findEmailCopy("dispatch-2@mailsense.local", [accA])).toBeNull();
  });

  it("пустой вход не роняет поиск", () => {
    expect(findEmailCopy("", [accA])).toBeNull();
    expect(findEmailCopy("dispatch-1@mailsense.local", [])).toBeNull();
  });
});
