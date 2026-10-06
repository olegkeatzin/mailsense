import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Черновики с вложениями: содержимое лежит файлами, в JSON — ссылки.
 * Здесь проверяется контракт сервиса, сквозной путь (HTTP → SMTP) — в
 * packages/server/src/drafts.autosave.e2e.test.ts.
 */
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { getDraft, insertAccount, insertAttachment, insertEmail, listDrafts } from "../repos.js";
import { NodeSecretStore } from "../secrets.js";
import { DraftAttachmentError, createDraft, draftDir, readDraftAttachment, removeDraft, saveDraft } from "./draftService.js";

let dir = "";
let accountId = "";
let emailId = "";
let emailFilePath = "";

const CONTENT = Buffer.from("содержимое вложения", "utf8");

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-draft-service-"));
  initApp({ dataDir: dir });
  accountId = insertAccount(
    {
      protocol: "pop3",
      host: "mail.test",
      port: 995,
      tls: "ssl",
      authType: "login",
      username: "drafter@mail.test",
      password: "p",
      settings: { signatureEnabled: false }
    },
    new NodeSecretStore(dir).encrypt("p")
  ).id;

  const email = insertEmail({
    accountId,
    folder: "INBOX",
    uid: "uid-1",
    messageId: "original@test.local",
    subject: "Письмо",
    from: { address: "sender@test.local" },
    to: [],
    cc: [],
    replyTo: null,
    inReplyTo: null,
    references: [],
    date: "2026-10-06T09:00:00.000Z",
    bodyText: "текст",
    bodyHtml: null,
    headers: {}
  });
  emailId = email.id;
  emailFilePath = path.join(dir, "attachment.bin");
  fs.writeFileSync(emailFilePath, CONTENT);
  insertAttachment({
    emailId,
    filename: "Договор (копия).pdf",
    mimeType: "application/pdf",
    size: CONTENT.length,
    storagePath: emailFilePath,
    extractedText: null,
    contentId: null,
    kind: "pdf",
    handled: true
  });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

const input = (attachments: Array<Record<string, unknown>>) => ({
  accountId,
  to: [{ address: "client@test.local" }],
  subject: "Черновик",
  bodyText: "текст",
  attachments: attachments as never
});

describe("раскладка вложений черновика", () => {
  test("данные уходят в файл, в JSON остаётся ссылка", () => {
    const draft = createDraft(input([{ filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));

    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0].data).toBeUndefined();
    expect(typeof draft.attachments[0].ref).toBe("string");
    expect(draft.attachments[0].size).toBe(CONTENT.length);
    // Файл лежит в каталоге черновика, и байты в нём — те же.
    const file = path.join(draftDir(draft.id), draft.attachments[0].ref as string);
    expect(fs.readFileSync(file).equals(CONTENT)).toBe(true);
    // В базе base64 нет — иначе автосохранение снова гоняло бы мегабайты.
    expect(JSON.stringify(getDraft(draft.id)!.attachments)).not.toContain(CONTENT.toString("base64"));
  });

  test("два вложения с одинаковым именем не затирают друг друга", () => {
    const second = Buffer.from("второй файл, другое содержимое", "utf8");
    const draft = createDraft(
      input([
        { filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") },
        { filename: "акт.pdf", mimeType: "application/pdf", data: second.toString("base64") }
      ])
    );

    const [a, b] = draft.attachments;
    expect(a.ref).not.toBe(b.ref);
    expect(fs.readFileSync(path.join(draftDir(draft.id), a.ref as string)).equals(CONTENT)).toBe(true);
    expect(fs.readFileSync(path.join(draftDir(draft.id), b.ref as string)).equals(second)).toBe(true);
    // Оба имени в метаданных сохранены как есть.
    expect(draft.attachments.map((x) => x.filename)).toEqual(["акт.pdf", "акт.pdf"]);
  });

  test("вложение письма копируется сервером: base64 по сети не гоняем", () => {
    const att = insertAttachment({
      emailId, filename: "из письма.pdf", mimeType: "application/pdf", size: CONTENT.length,
      storagePath: emailFilePath, extractedText: null, contentId: null, kind: "pdf", handled: true
    });

    const draft = createDraft(
      input([{ filename: "из письма.pdf", mimeType: "application/pdf", size: CONTENT.length, emailRef: { emailId, attachmentId: att.id } }])
    );

    expect(draft.attachments[0].ref).toBeTruthy();
    expect(fs.readFileSync(path.join(draftDir(draft.id), draft.attachments[0].ref as string)).equals(CONTENT)).toBe(true);
  });

  test("вложения письма нет — ошибка данных, а не пустое вложение", () => {
    expect(() =>
      createDraft(input([{ filename: "нет.pdf", mimeType: "application/pdf", emailRef: { emailId, attachmentId: "нет-такого" } }]))
    ).toThrow(DraftAttachmentError);
  });

  test("вложение без данных и без ссылки не сохраняется молча", () => {
    expect(() => createDraft(input([{ filename: "пусто.pdf", mimeType: "application/pdf" }]))).toThrow(DraftAttachmentError);
  });
});

describe("повторное сохранение", () => {
  test("ссылка остаётся ссылкой, файлы не размножаются", () => {
    const draft = createDraft(input([{ filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));
    const ref = draft.attachments[0].ref as string;

    const saved = saveDraft(draft.id, {
      attachments: [{ filename: "акт.pdf", mimeType: "application/pdf", size: CONTENT.length, ref }] as never
    });

    expect(saved!.attachments[0]).toEqual({ filename: "акт.pdf", mimeType: "application/pdf", size: CONTENT.length, ref });
    // Ровно один файл: автосохранение не плодит копии.
    expect(fs.readdirSync(draftDir(draft.id))).toEqual([ref]);
  });

  test("убрали вложение — его файл не остаётся на диске", () => {
    const second = Buffer.from("второй файл", "utf8");
    const draft = createDraft(
      input([
        { filename: "первый.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") },
        { filename: "второй.pdf", mimeType: "application/pdf", data: second.toString("base64") }
      ])
    );
    expect(fs.readdirSync(draftDir(draft.id))).toHaveLength(2);

    const kept = draft.attachments[0];
    const saved = saveDraft(draft.id, {
      attachments: [{ filename: kept.filename, mimeType: kept.mimeType, size: kept.size, ref: kept.ref }] as never
    });

    expect(saved!.attachments).toHaveLength(1);
    expect(fs.readdirSync(draftDir(draft.id))).toEqual([kept.ref]);
  });

  test("несуществующий черновик — null, а не исключение", () => {
    expect(saveDraft("нет-такого", { subject: "x" })).toBeNull();
  });
});

describe("чтение по ссылке", () => {
  test("своя ссылка читается, чужая — нет", () => {
    const draft = createDraft(input([{ filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));
    const ref = draft.attachments[0].ref as string;
    expect(readDraftAttachment(draft.id, ref)!.equals(CONTENT)).toBe(true);

    // Ссылка — имя файла В КАТАЛОГЕ ЧЕРНОВИКА, поэтому её ищут в списке вложений
    // именно этого черновика: у другого черновика такого вложения нет.
    const other = createDraft(input([{ filename: "письмо.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));
    expect(readDraftAttachment(other.id, ref)).toBeNull();
    expect(readDraftAttachment(other.id, other.attachments[0].ref as string)).not.toBeNull();
  });

  test("подстановка пути не проходит: ссылка — только имя файла", () => {
    const draft = createDraft(input([{ filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));
    expect(readDraftAttachment(draft.id, "../" + draft.id + "/" + (draft.attachments[0].ref as string))).toBeNull();
    expect(readDraftAttachment(draft.id, "..\\" + (draft.attachments[0].ref as string))).toBeNull();
    expect(readDraftAttachment(draft.id, "подкаталог/файл.pdf")).toBeNull();
    // И сохранить такую ссылку тоже нельзя.
    expect(() =>
      saveDraft(draft.id, { attachments: [{ filename: "акт.pdf", mimeType: "application/pdf", ref: "../чужой.pdf" }] as never })
    ).toThrow(DraftAttachmentError);
  });
});

describe("удаление", () => {
  test("вместе с черновиком убираются его файлы", () => {
    const draft = createDraft(input([{ filename: "акт.pdf", mimeType: "application/pdf", data: CONTENT.toString("base64") }]));
    expect(fs.existsSync(draftDir(draft.id))).toBe(true);

    removeDraft(draft.id);

    expect(getDraft(draft.id)).toBeNull();
    expect(fs.existsSync(draftDir(draft.id))).toBe(false);
    expect(listDrafts(accountId).some((d) => d.id === draft.id)).toBe(false);
  });
});
