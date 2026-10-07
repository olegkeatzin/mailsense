import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initApp } from "./init.js";
import { closeDb } from "./db/index.js";
import {
  deleteAccount,
  deleteEmails,
  getEmail,
  insertAccount,
  insertAttachment,
  insertDraft,
  insertEmail
} from "./repos.js";

/**
 * Удаление ящика и писем не должно оставлять файлы-сироты: живой прогон нашёл
 * 1,44 МБ мусора после DELETE /api/accounts/:id. Файл удаляем только тогда, когда
 * на него больше не ссылается НИ ОДНА строка attachments.
 */

let dir = "";
let accountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-cleanup-"));
  initApp({ dataDir: dir });
  accountId = insertAccount(
    { protocol: "imap", host: "mail.test", port: 993, tls: "ssl", username: "cleanup@mail.test", authType: "login" },
    "enc"
  ).id;
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

/** Письмо с файлом вложения на диске. */
function makeEmailWithFile(uid: string, filename = "акт.pdf"): { emailId: string; file: string } {
  const email = insertEmail({
    accountId,
    folder: "INBOX",
    uid,
    messageId: uid + "@test.local",
    subject: "Письмо " + uid,
    from: { address: "sender@test.local" },
    to: [{ address: "me@test.local" }],
    date: "2026-09-01T10:00:00Z",
    bodyText: "тело",
    bodyHtml: null,
    headers: { subject: "Письмо" }
  });
  const file = path.join(dir, "attachments", email.id, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "содержимое вложения");
  insertAttachment({
    emailId: email.id,
    filename,
    mimeType: "application/pdf",
    size: 20,
    storagePath: file,
    extractedText: null,
    contentId: null,
    kind: "pdf",
    handled: true
  });
  return { emailId: email.id, file };
}

describe("удаление письма", () => {
  test("файл удалённого письма уходит, файлы других писем остаются", () => {
    const doomed = makeEmailWithFile("del-1");
    const kept = makeEmailWithFile("del-2");

    expect(deleteEmails([doomed.emailId])).toBe(1);

    expect(fs.existsSync(doomed.file)).toBe(false);
    expect(fs.existsSync(kept.file)).toBe(true);
    expect(getEmail(doomed.emailId)).toBeNull();
    expect(getEmail(kept.emailId)).not.toBeNull();
  });

  test("массовое удаление убирает все файлы этих писем", () => {
    const a = makeEmailWithFile("del-3");
    const b = makeEmailWithFile("del-4");
    const kept = makeEmailWithFile("del-5");

    expect(deleteEmails([a.emailId, b.emailId])).toBe(2);

    expect(fs.existsSync(a.file)).toBe(false);
    expect(fs.existsSync(b.file)).toBe(false);
    expect(fs.existsSync(kept.file)).toBe(true);
  });

  test("общий storagePath не удаляется, пока на него ссылается другая строка", () => {
    const first = makeEmailWithFile("shared-1", "общий.pdf");
    const email2 = insertEmail({
      accountId,
      folder: "INBOX",
      uid: "shared-2",
      messageId: "shared-2@test.local",
      subject: "Второе письмо",
      from: { address: "sender@test.local" },
      to: [],
      date: "2026-09-01T10:00:00Z",
      bodyText: "тело",
      bodyHtml: null,
      headers: { subject: "Второе" }
    });
    // Та же самая физическая строка на диске — на неё ссылаются обе записи.
    insertAttachment({
      emailId: email2.id,
      filename: "общий.pdf",
      mimeType: "application/pdf",
      size: 20,
      storagePath: first.file,
      extractedText: null,
      contentId: null,
      kind: "pdf",
      handled: true
    });

    deleteEmails([first.emailId]);

    // Сначала файл ещё нужен второму письму, и только после его удаления уходит.
    expect(fs.existsSync(first.file)).toBe(true);
    deleteEmails([email2.id]);
    expect(fs.existsSync(first.file)).toBe(false);
  });

  test("ошибка удаления файла не откатывает удаление записи", () => {
    const email = insertEmail({
      accountId,
      folder: "INBOX",
      uid: "broken",
      messageId: "broken@test.local",
      subject: "Битый путь",
      from: { address: "sender@test.local" },
      to: [],
      date: "2026-09-01T10:00:00Z",
      bodyText: "тело",
      bodyHtml: null,
      headers: { subject: "Битый" }
    });
    // Путь указывает на КАТАЛОГ: unlink такого пути падает. Запись всё равно обязана удалиться.
    const asDir = path.join(dir, "attachments", "каталог-вместо-файла");
    fs.mkdirSync(asDir, { recursive: true });
    insertAttachment({
      emailId: email.id,
      filename: "странный.pdf",
      mimeType: "application/pdf",
      size: 0,
      storagePath: asDir,
      extractedText: null,
      contentId: null,
      kind: "pdf",
      handled: true
    });

    expect(() => deleteEmails([email.id])).not.toThrow();
    expect(getEmail(email.id)).toBeNull();
    expect(fs.existsSync(asDir)).toBe(true);
  });

  test("отсутствующий файл не мешает удалению", () => {
    const doomed = makeEmailWithFile("gone");
    fs.rmSync(doomed.file);
    expect(() => deleteEmails([doomed.emailId])).not.toThrow();
    expect(getEmail(doomed.emailId)).toBeNull();
  });
});

describe("удаление ящика", () => {
  test("файлы писем уходят вместе с ящиком", () => {
    const acc = insertAccount(
      { protocol: "imap", host: "mail.test", port: 993, tls: "ssl", username: "doomed-box@mail.test", authType: "login" },
      "enc"
    ).id;
    const email = insertEmail({
      accountId: acc,
      folder: "INBOX",
      uid: "box-1",
      messageId: "box-1@test.local",
      subject: "Письмо ящика",
      from: { address: "sender@test.local" },
      to: [],
      date: "2026-09-01T10:00:00Z",
      bodyText: "тело",
      bodyHtml: null,
      headers: { subject: "Ящик" }
    });
    const file = path.join(dir, "attachments", email.id, "вх.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "файл");
    insertAttachment({
      emailId: email.id,
      filename: "вх.pdf",
      mimeType: "application/pdf",
      size: 4,
      storagePath: file,
      extractedText: null,
      contentId: null,
      kind: "pdf",
      handled: true
    });

    deleteAccount(acc);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.dirname(file))).toBe(false); // пустой каталог письма тоже не нужен
  });

  test("файлы черновиков удалённого ящика тоже уходят", () => {
    const acc = insertAccount(
      { protocol: "imap", host: "mail.test", port: 993, tls: "ssl", username: "draft-box@mail.test", authType: "login" },
      "enc"
    ).id;
    const draft = insertDraft({ accountId: acc, to: [], subject: "Черновик", bodyText: "текст" });
    const draftDir = path.join(dir, "drafts", draft.id);
    fs.mkdirSync(draftDir, { recursive: true });
    fs.writeFileSync(path.join(draftDir, "вложение.bin"), "данные");

    deleteAccount(acc);

    expect(fs.existsSync(draftDir)).toBe(false);
  });
});
