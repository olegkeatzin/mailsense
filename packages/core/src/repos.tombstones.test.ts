import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDb, closeDb } from "./db/index.js";
import {
  clearDeletedEmail,
  deleteEmails,
  emailExistsByMessageId,
  insertAccount,
  insertEmail,
  knownUidsForAccount
} from "./repos.js";

let accountId = "";
let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-tombstones-"));
  initDb(dir);
  accountId = insertAccount(
    {
      protocol: "imap",
      host: "localhost",
      port: 993,
      tls: "ssl",
      username: "test@test.local",
      authType: "login"
    },
    "enc"
  ).id;
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function addEmail(uid: string, messageId: string) {
  return insertEmail({
    accountId,
    folder: "INBOX",
    uid,
    messageId,
    subject: "Письмо " + uid,
    from: { address: "sender@test.local" },
    to: [{ address: "me@test.local" }],
    date: "2026-09-01T10:00:00Z",
    bodyText: "тело",
    bodyHtml: null,
    headers: {}
  });
}

describe("надгробия удалённых писем", () => {
  test("после удаления UID известен, но ручной скан его игнорирует", () => {
    const email = addEmail("uid-1", "msg-1@test");
    expect(deleteEmails([email.id])).toBe(1);

    // авто-скан: удалённое письмо считается известным и не скачивается повторно
    expect(knownUidsForAccount(accountId, "INBOX").has("uid-1")).toBe(true);
    expect(emailExistsByMessageId("msg-1@test")).toBe(true);

    // ручной скан: удалённое письмо можно забрать заново
    expect(knownUidsForAccount(accountId, "INBOX", true).has("uid-1")).toBe(false);
    expect(emailExistsByMessageId("msg-1@test", true)).toBe(false);
  });

  test("снятие надгробия возвращает UID в неизвестные", () => {
    const email = addEmail("uid-2", "msg-2@test");
    deleteEmails([email.id]);
    expect(knownUidsForAccount(accountId, "INBOX").has("uid-2")).toBe(true);

    clearDeletedEmail(accountId, "INBOX", "uid-2", "msg-2@test");

    expect(knownUidsForAccount(accountId, "INBOX").has("uid-2")).toBe(false);
    expect(knownUidsForAccount(accountId, "INBOX", true).has("uid-2")).toBe(false);
    expect(emailExistsByMessageId("msg-2@test")).toBe(false);
  });
});
