import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "./db/index.js";
import { deletedEmails } from "./db/schema.js";
import {
  clearDeletedEmail,
  deleteEmails,
  emailExistsByMessageId,
  getAnalysis,
  getEmail,
  insertAccount,
  insertAttachment,
  insertEmail,
  knownUidsForAccount,
  listAttachments,
  upsertAnalysis
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

describe("атомарность удаления", () => {
  /** Надгробий у письма: 0 — удаление не состоялось. */
  function tombstonesFor(messageId: string): number {
    return getDb().select().from(deletedEmails).where(eq(deletedEmails.messageId, messageId)).all().length;
  }

  function emailWithAnalysisAndAttachment(uid: string, messageId: string) {
    const email = addEmail(uid, messageId);
    upsertAnalysis({
      emailId: email.id,
      summary: "кратко",
      tags: ["акт"],
      priority: 3,
      urgent: false,
      eventDate: null,
      category: "personal",
      rawResponse: "{}",
      modelUsed: "test"
    });
    insertAttachment({
      emailId: email.id,
      filename: "akt.pdf",
      mimeType: "application/pdf",
      size: 10,
      storagePath: null,
      extractedText: null,
      contentId: null,
      kind: "pdf",
      handled: true
    });
    return email;
  }

  test("успешное удаление убирает письмо, анализ и вложения, оставляя надгробие", () => {
    const email = emailWithAnalysisAndAttachment("uid-full", "msg-full@test");
    expect(deleteEmails([email.id])).toBe(1);

    expect(getEmail(email.id)).toBeNull();
    expect(getAnalysis(email.id)).toBeNull();
    expect(listAttachments(email.id)).toEqual([]);
    expect(tombstonesFor("msg-full@test")).toBe(1);
  });

  test("сбой на середине удаления откатывает всё, а не оставляет половинчатое состояние", () => {
    const email = emailWithAnalysisAndAttachment("uid-atomic", "msg-atomic@test");

    // Имитируем сбой хранилища ровно на шаге удаления вложений: без транзакции
    // надгробие и удалённый анализ остались бы, а письмо — нет.
    getDb().run(
      sql.raw(
        "CREATE TRIGGER fail_attachments_delete BEFORE DELETE ON attachments" +
          " WHEN OLD.email_id = '" + email.id + "'" +
          " BEGIN SELECT RAISE(ABORT, 'диск недоступен'); END"
      )
    );
    try {
      expect(() => deleteEmails([email.id])).toThrow();

      // Письмо цело вместе с анализом и вложениями: частичного удаления нет.
      expect(getEmail(email.id)).not.toBeNull();
      expect(getAnalysis(email.id)).not.toBeNull();
      expect(listAttachments(email.id)).toHaveLength(1);
      // И надгробия нет — иначе авто-скан навсегда пропустил бы это письмо.
      expect(tombstonesFor("msg-atomic@test")).toBe(0);
    } finally {
      getDb().run(sql.raw("DROP TRIGGER IF EXISTS fail_attachments_delete"));
    }

    // После снятия сбоя удаление проходит целиком.
    expect(deleteEmails([email.id])).toBe(1);
    expect(tombstonesFor("msg-atomic@test")).toBe(1);
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