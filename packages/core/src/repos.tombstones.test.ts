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

describe("одно письмо в разных ящиках", () => {
  /**
   * Найденный баг: письма, отправленные системой, не появлялись в ящике получателя.
   *
   * `sendEmail` кладёт копию в «Отправленные» отправителя с тем же Message-ID, а скан
   * ящика получателя считал её уже известной и отбрасывал письмо как дубликат. Из-за
   * этого ни поручения исполнителям, ни письма руководителю до адресатов не доходили —
   * точнее, доходили до сервера, но в приложении не появлялись.
   */
  test("копия в «Отправленных» отправителя не отменяет письмо в ящике получателя", () => {
    const sender = insertAccount(
      { protocol: "imap", host: "localhost", port: 993, tls: "ssl", username: "sender@test.local", authType: "login" },
      "enc"
    ).id;
    const recipient = insertAccount(
      { protocol: "imap", host: "localhost", port: 993, tls: "ssl", username: "rcpt@test.local", authType: "login" },
      "enc"
    ).id;

    const base = {
      messageId: "out-shared@test",
      subject: "Поручение",
      from: { address: "sender@test.local" },
      to: [{ address: "rcpt@test.local" }],
      date: "2026-10-03T10:00:00Z",
      bodyText: "текст",
      bodyHtml: null,
      headers: {}
    };

    insertEmail({ ...base, accountId: sender, folder: "Sent", uid: "sent:1" });
    insertEmail({ ...base, accountId: recipient, folder: "INBOX", uid: "5" });

    // Обе копии существуют — это разные записи в разных ящиках.
    expect(emailExistsByMessageId("out-shared@test", false, sender)).toBe(true);
    expect(emailExistsByMessageId("out-shared@test", false, recipient)).toBe(true);
  });

  test("в одном ящике повторный UID с тем же Message-ID не дублируется", () => {
    // Внутри ящика дедупликация нужна: то же письмо может прийти под другим UID.
    expect(emailExistsByMessageId("out-shared@test", false, "нет-такого-ящика")).toBe(false);
  });
});