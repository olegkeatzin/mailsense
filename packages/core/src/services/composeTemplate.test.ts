import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Сборка шаблона письма (ответ/пересылка/новое). Здесь ошибка видна пользователю
 * сразу: не тот получатель, потерянная цитата, забытое вложение.
 */
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { insertAccount, insertAttachment, insertEmail } from "../repos.js";
import { NodeSecretStore } from "../secrets.js";
import { buildComposeTemplate, formatAddress, quoteHtml } from "./composeService.js";

let dir = "";
let accountId = "";
let otherAccountId = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-compose-"));
  initApp({ dataDir: dir });
  const secrets = new NodeSecretStore(dir);
  const base = { protocol: "imap" as const, host: "mail.test", port: 993, tls: "ssl" as const, authType: "login" as const };
  accountId = insertAccount(
    { ...base, username: "me@mail.test", password: "p", settings: { signature: "С уважением, Я", signatureEnabled: true } },
    secrets.encrypt("p")
  ).id;
  otherAccountId = insertAccount(
    { ...base, username: "other@mail.test", password: "p", settings: { signature: "Чужая подпись", signatureEnabled: true } },
    secrets.encrypt("p")
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

function makeEmail(over: Record<string, unknown> = {}) {
  return insertEmail({
    accountId,
    folder: "INBOX",
    uid: "uid-" + Math.random().toString(36).slice(2),
    messageId: "msg-" + Math.random().toString(36).slice(2),
    subject: "Исходное письмо",
    from: { name: "Отправитель", address: "sender@test.local" },
    to: [{ name: "Я", address: "me@mail.test" }],
    cc: [],
    replyTo: null,
    inReplyTo: null,
    references: [],
    date: "2026-09-29T18:04:00.000Z",
    bodyText: "Текст оригинала",
    bodyHtml: null,
    headers: {},
    ...over
  });
}

describe("новое письмо", () => {
  test("получателей нет, подпись на месте", () => {
    const t = buildComposeTemplate({ accountId, mode: "new" });
    expect(t.to).toEqual([]);
    expect(t.cc).toEqual([]);
    expect(t.subject).toBe("");
    expect(t.bodyText).toContain("С уважением, Я");
  });

  test("режим new игнорирует переданное письмо", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "new", emailId: email.id });
    expect(t.inReplyToEmailId).toBeNull();
    expect(t.subject).toBe("");
  });

  test("несуществующий аккаунт — понятная ошибка", () => {
    expect(() => buildComposeTemplate({ accountId: "нет-такого", mode: "new" })).toThrow(/Аккаунт не найден/);
  });
});

describe("шаблон без подписи ящика (личная подпись клиента)", () => {
  test("новое письмо: тело пустое, подписи ящика нет", () => {
    const t = buildComposeTemplate({ accountId, mode: "new", useAccountSignature: false });
    expect(t.bodyText).toBe("");
    expect(t.bodyHtml).toBe("");
  });

  test("ответ: цитата на месте, подписи ящика нет", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id, useAccountSignature: false });

    expect(t.bodyText).toContain("> Текст оригинала");
    expect(t.bodyText).not.toContain("С уважением, Я");
    expect(t.bodyHtml).toContain("<blockquote");
    expect(t.bodyHtml).not.toContain("mailsense-signature");
  });

  test("пересылка: шапка на месте, подписи ящика нет", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "forward", emailId: email.id, useAccountSignature: false });

    expect(t.bodyText).toContain("Перенаправленное сообщение");
    expect(t.bodyText).not.toContain("С уважением, Я");
  });

  test("по умолчанию поведение прежнее — подпись ящика на месте", () => {
    expect(buildComposeTemplate({ accountId, mode: "new" }).bodyText).toContain("С уважением, Я");
  });
});

describe("ответ", () => {
  test("получатель — отправитель оригинала, тема с Re:", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });

    expect(t.to[0].address).toBe("sender@test.local");
    expect(t.subject).toBe("Re: Исходное письмо");
    expect(t.inReplyToEmailId).toBe(email.id);
    expect(t.inReplyToMessageId).toBe(email.messageId);
  });

  test("Reply-To имеет приоритет над From", () => {
    const email = makeEmail({ replyTo: [{ address: "replies@test.local" }] });
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });
    // Письмо могло уйти из рассылки — отвечать надо туда, куда просил отправитель.
    expect(t.to[0].address).toBe("replies@test.local");
  });

  test("в теле есть цитата и подпись", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });
    expect(t.bodyText).toContain("> Текст оригинала");
    expect(t.bodyText).toContain("С уважением, Я");
    expect(t.bodyHtml).toContain("<blockquote");
  });

  test("отключённая цитата не добавляется", () => {
    const email = makeEmail();
    const withQuote = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });
    expect(withQuote.bodyText).toContain("> Текст оригинала");

    const noQuoteAcc = insertAccount(
      { protocol: "imap", host: "m", port: 993, tls: "ssl", authType: "login", username: "nq@mail.test", password: "p", settings: { replyQuote: false, signatureEnabled: false } },
      new NodeSecretStore(dir).encrypt("p")
    ).id;
    const email2 = insertEmail({
      accountId: noQuoteAcc,
      folder: "INBOX",
      uid: "u2",
      messageId: "m2",
      subject: "Без цитаты",
      from: { address: "s@test.local" },
      to: [],
      cc: [],
      replyTo: null,
      inReplyTo: null,
      references: [],
      date: "2026-09-29T18:04:00.000Z",
      bodyText: "Текст",
      bodyHtml: null,
      headers: {}
    });
    const t = buildComposeTemplate({ accountId: noQuoteAcc, mode: "reply", emailId: email2.id });
    expect(t.bodyText).not.toContain("> Текст");
  });

  test("переписка ссылается на оригинал", () => {
    const email = makeEmail({ messageId: "parent@test.local", references: ["root@test.local"] });
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });
    // Порядок важен: от старых к новым, иначе почтовики не склеят переписку.
    expect(t.references).toEqual(["root@test.local", "parent@test.local"]);
  });

  test("несуществующее письмо — понятная ошибка", () => {
    expect(() => buildComposeTemplate({ accountId, mode: "reply", emailId: "нет-такого" })).toThrow(/не найдено/);
  });
});

describe("ответ всем", () => {
  test("остальные получатели уходят в копию", () => {
    const email = makeEmail({
      to: [{ address: "me@mail.test" }, { address: "colleague@test.local" }],
      cc: [{ address: "boss@test.local" }]
    });
    const t = buildComposeTemplate({ accountId, mode: "replyAll", emailId: email.id });

    expect(t.to[0].address).toBe("sender@test.local");
    expect(t.cc.map((a) => a.address)).toEqual(["colleague@test.local", "boss@test.local"]);
  });

  test("свой адрес не попадает в копию", () => {
    const email = makeEmail({ to: [{ address: "ME@mail.test" }, { address: "x@test.local" }] });
    const t = buildComposeTemplate({ accountId, mode: "replyAll", emailId: email.id });
    // Иначе человек отправит копию самому себе.
    expect(t.cc.some((a) => a.address.toLowerCase() === "me@mail.test")).toBe(false);
  });

  test("получатель не дублируется в копии", () => {
    const email = makeEmail({ to: [{ address: "sender@test.local" }, { address: "sender@test.local" }] });
    const t = buildComposeTemplate({ accountId, mode: "replyAll", emailId: email.id });
    expect(t.cc).toEqual([]);
  });

  test("обычный ответ копию не заполняет", () => {
    const email = makeEmail({ to: [{ address: "colleague@test.local" }] });
    const t = buildComposeTemplate({ accountId, mode: "reply", emailId: email.id });
    expect(t.cc).toEqual([]);
  });
});

describe("подпись", () => {
  test("положение «сверху» ставит подпись перед цитатой", () => {
    const acc = insertAccount(
      { protocol: "imap", host: "m", port: 993, tls: "ssl", authType: "login", username: "above@mail.test", password: "p", settings: { signature: "ПОДПИСЬ", signaturePosition: "above" } },
      new NodeSecretStore(dir).encrypt("p")
    ).id;
    const email = insertEmail({
      accountId: acc, folder: "INBOX", uid: "u3", messageId: "m3", subject: "Тема",
      from: { address: "s@test.local" }, to: [], cc: [], replyTo: null, inReplyTo: null,
      references: [], date: "2026-09-29T18:04:00.000Z", bodyText: "Оригинал", bodyHtml: null, headers: {}
    });
    const t = buildComposeTemplate({ accountId: acc, mode: "reply", emailId: email.id });
    expect(t.bodyText.indexOf("ПОДПИСЬ")).toBeLessThan(t.bodyText.indexOf("> Оригинал"));
  });

  test("отключённая подпись не добавляется", () => {
    const acc = insertAccount(
      { protocol: "imap", host: "m", port: 993, tls: "ssl", authType: "login", username: "nosig@mail.test", password: "p", settings: { signature: "НЕ НУЖНА", signatureEnabled: false } },
      new NodeSecretStore(dir).encrypt("p")
    ).id;
    const t = buildComposeTemplate({ accountId: acc, mode: "new" });
    expect(t.bodyText).not.toContain("НЕ НУЖНА");
  });
});

describe("пересылка", () => {
  test("тема с Fwd: и шапка оригинала", () => {
    const email = makeEmail();
    const t = buildComposeTemplate({ accountId, mode: "forward", emailId: email.id });

    expect(t.subject).toBe("Fwd: Исходное письмо");
    expect(t.bodyText).toContain("Перенаправленное сообщение");
    expect(t.bodyText).toContain("Тема: Исходное письмо");
    expect(t.bodyText).toContain("От: Отправитель <sender@test.local>");
    expect(t.bodyText).toContain("Текст оригинала");
    // Пересылка не отвечает — получателя выбирает человек.
    expect(t.to).toEqual([]);
    expect(t.inReplyToEmailId).toBeNull();
  });

  test("вложение оригинала прикладывается ссылкой, без данных в шаблоне", () => {
    const email = makeEmail();
    const file = path.join(dir, "акт.txt");
    fs.writeFileSync(file, "содержимое", "utf8");
    const att = insertAttachment({
      emailId: email.id, filename: "акт.txt", mimeType: "text/plain", size: 10,
      storagePath: file, extractedText: null, contentId: null, kind: "text", handled: true
    });

    const t = buildComposeTemplate({ accountId, mode: "forward", emailId: email.id });

    expect(t.attachments).toEqual([
      {
        filename: "акт.txt",
        mimeType: "text/plain",
        size: 20,
        attachmentId: att.id,
        emailId: email.id
      }
    ]);
    // ⚠️ Данных файла в ответе быть не должно. Раньше сервер вкладывал вложение
    // целиком в base64: письмо на 20 МБ превращалось в ~27 МБ JSON, который он
    // собирал в памяти, а клиент держал в состоянии и отправлял обратно.
    expect(JSON.stringify(t)).not.toContain(Buffer.from("содержимое").toString("base64"));
  });

  test("размер берётся с диска, а не из базы", () => {
    const email = makeEmail();
    const file = path.join(dir, "счёт.pdf");
    fs.writeFileSync(file, Buffer.alloc(1234, 7));
    insertAttachment({
      emailId: email.id, filename: "счёт.pdf", mimeType: "application/pdf", size: 0,
      storagePath: file, extractedText: null, contentId: null, kind: "pdf", handled: true
    });

    // В базе размер может быть нулевым или устаревшим (файл дедуплицирован) —
    // показывать надо то, что реально лежит на диске и уйдёт в письмо.
    expect(buildComposeTemplate({ accountId, mode: "forward", emailId: email.id }).attachments[0].size).toBe(1234);
  });

  test("кириллическое имя и два одинаковых имени не теряются", () => {
    const email = makeEmail();
    const one = path.join(dir, "копия-1.bin");
    const two = path.join(dir, "копия-2.bin");
    fs.writeFileSync(one, "первый файл", "utf8");
    fs.writeFileSync(two, "второй файл", "utf8");
    const a1 = insertAttachment({
      emailId: email.id, filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 11,
      storagePath: one, extractedText: null, contentId: null, kind: "pdf", handled: true
    });
    const a2 = insertAttachment({
      emailId: email.id, filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 11,
      storagePath: two, extractedText: null, contentId: null, kind: "pdf", handled: true
    });

    const t = buildComposeTemplate({ accountId, mode: "forward", emailId: email.id });

    // Каждое вложение — отдельная ссылка: письмо уйдёт с обоими файлами,
    // хотя имена совпадают.
    expect(t.attachments.map((a) => [a.filename, a.attachmentId])).toEqual([
      ["Договор (копия).pdf", a1.id],
      ["Договор (копия).pdf", a2.id]
    ]);
  });

  test("вложение без файла на диске пропускается", () => {
    const email = makeEmail();
    insertAttachment({
      emailId: email.id, filename: "потерянный.txt", mimeType: "text/plain", size: 1,
      storagePath: path.join(dir, "нет-такого-файла.txt"), extractedText: null, contentId: null, kind: "text", handled: true
    });
    const t = buildComposeTemplate({ accountId, mode: "forward", emailId: email.id });
    expect(t.attachments).toEqual([]);
  });

  test("отключённая пересылка вложений не прикладывает файлы", () => {
    const acc = insertAccount(
      { protocol: "imap", host: "m", port: 993, tls: "ssl", authType: "login", username: "noatt@mail.test", password: "p", settings: { forwardAttachments: false } },
      new NodeSecretStore(dir).encrypt("p")
    ).id;
    const email = insertEmail({
      accountId: acc, folder: "INBOX", uid: "u4", messageId: "m4", subject: "Тема",
      from: { address: "s@test.local" }, to: [], cc: [], replyTo: null, inReplyTo: null,
      references: [], date: "2026-09-29T18:04:00.000Z", bodyText: "т", bodyHtml: null, headers: {}
    });
    const file = path.join(dir, "вложение.txt");
    fs.writeFileSync(file, "данные", "utf8");
    insertAttachment({
      emailId: email.id, filename: "вложение.txt", mimeType: "text/plain", size: 5,
      storagePath: file, extractedText: null, contentId: null, kind: "text", handled: true
    });
    expect(buildComposeTemplate({ accountId: acc, mode: "forward", emailId: email.id }).attachments).toEqual([]);
  });
});

describe("оформление адресов и цитаты", () => {
  test("адрес с именем и без", () => {
    expect(formatAddress({ name: "Иванов", address: "i@t" })).toBe("Иванов <i@t>");
    expect(formatAddress({ address: "i@t" })).toBe("i@t");
    expect(formatAddress(null)).toBe("");
  });

  test("HTML-цитата экранирует текст, если нет HTML", () => {
    const html = quoteHtml("Атрибуция", null, "<script>alert(1)</script>");
    // Иначе чужой скрипт из письма выполнится в окне композера.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML-цитата использует оригинальный HTML, когда он есть", () => {
    const html = quoteHtml("Атрибуция", "<p>оригинал</p>", "текст");
    expect(html).toContain("<p>оригинал</p>");
    expect(html).toContain("<blockquote");
  });

  test("цитата без атрибуции не рисует пустой абзац", () => {
    expect(quoteHtml("", null, "текст")).not.toContain("mailsense-attribution");
  });
});
