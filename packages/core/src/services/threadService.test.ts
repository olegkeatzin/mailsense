import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDb, closeDb } from "../db/index.js";
import { insertAccount, insertEmail, listEmails, getEmail } from "../repos.js";
import { assignThread, listThreadsGrouped, normalizeSubject, baseSubject, rebuildThreads } from "./threadService.js";
import type { Email } from "../types.js";

let accountId = "";
let dir = "";

function addEmail(partial: {
  messageId: string;
  subject: string;
  date: string;
  inReplyTo?: string | null;
  references?: string[];
  folder?: string;
}): Email {
  return insertEmail({
    accountId,
    folder: partial.folder ?? "INBOX",
    uid: "uid:" + partial.messageId,
    messageId: partial.messageId,
    subject: partial.subject,
    from: { address: "sender@test.local" },
    to: [{ address: "me@test.local" }],
    inReplyTo: partial.inReplyTo ?? null,
    references: partial.references ?? [],
    date: partial.date,
    bodyText: partial.subject,
    bodyHtml: null,
    headers: {}
  });
}

function threadOf(email: Email): string | null {
  return getEmail(email.id)!.threadId;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-threads-"));
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

describe("normalizeSubject", () => {
  test("срезает Re:/Fwd:/Ответ: и вложенные префиксы", () => {
    expect(normalizeSubject("Re: Re: Проект Аполлон")).toBe("проект аполлон");
    expect(normalizeSubject("Fwd: Счёт")).toBe("счёт");
    expect(normalizeSubject("Ответ: Вопрос")).toBe("вопрос");
  });

  test("срезает Re: в середине темы (рассылки с тегом)", () => {
    expect(normalizeSubject("МТ и РИ: Re: Federated MeZO")).toBe("мт и ри: federated mezo");
  });

  test("baseSubject сохраняет регистр", () => {
    expect(baseSubject("Re: Проект Аполлон")).toBe("Проект Аполлон");
  });
});

describe("assignThread", () => {
  test("склеивает цепочку ответов в одну беседу", () => {
    const root = addEmail({ messageId: "root-1@t", subject: "Проект Аполлон", date: "2026-01-01T10:00:00Z" });
    assignThread(root);
    const r1 = addEmail({
      messageId: "r1@t",
      subject: "Re: Проект Аполлон",
      date: "2026-01-02T10:00:00Z",
      inReplyTo: "root-1@t",
      references: ["root-1@t"]
    });
    assignThread(r1);
    const r2 = addEmail({
      messageId: "r2@t",
      subject: "Re: Re: Проект Аполлон",
      date: "2026-01-03T10:00:00Z",
      inReplyTo: "r1@t",
      references: ["root-1@t", "r1@t"]
    });
    assignThread(r2);
    expect(threadOf(root)).toBe(threadOf(r1));
    expect(threadOf(r2)).toBe(threadOf(root));
  });

  test("склеивает ответы без родителя по теме (как рассылки moodle)", () => {
    const a = addEmail({
      messageId: "orphan-a@t",
      subject: "МТ и РИ: Re: Federated MeZO",
      date: "2026-02-01T10:00:00Z",
      inReplyTo: "missing@t",
      references: ["missing@t"]
    });
    assignThread(a);
    const b = addEmail({
      messageId: "orphan-b@t",
      subject: "МТ и РИ: Re: Federated MeZO",
      date: "2026-02-02T10:00:00Z",
      inReplyTo: "missing@t",
      references: ["missing@t"]
    });
    assignThread(b);
    expect(threadOf(b)).toBe(threadOf(a));
  });

  test("НЕ склеивает одинаковые темы без признаков ответа", () => {
    const a = addEmail({ messageId: "news-a@t", subject: "Уведомление о новом счете за ЖКУ", date: "2026-03-01T10:00:00Z" });
    assignThread(a);
    const b = addEmail({ messageId: "news-b@t", subject: "Уведомление о новом счете за ЖКУ", date: "2026-03-02T10:00:00Z" });
    assignThread(b);
    expect(threadOf(b)).not.toBe(threadOf(a));
  });

  test("родитель, пришедший позже ребёнка, объединяет беседу", () => {
    const child = addEmail({
      messageId: "child-late@t",
      subject: "Re: Поздний родитель",
      date: "2026-04-01T10:00:00Z",
      inReplyTo: "parent-late@t",
      references: ["parent-late@t"]
    });
    assignThread(child);
    const parent = addEmail({ messageId: "parent-late@t", subject: "Поздний родитель", date: "2026-04-02T10:00:00Z" });
    assignThread(parent);
    expect(threadOf(child)).toBe(threadOf(parent));
  });
});

describe("listThreadsGrouped", () => {
  test("возвращает беседы с сообщениями в хронологическом порядке", () => {
    const all = listEmails({ accountId });
    expect(all.length).toBeGreaterThan(0);
    const groups = listThreadsGrouped({ accountId });
    expect(groups.length).toBeGreaterThan(0);
    const apollo = groups.find((g) => g.subject === "Проект Аполлон");
    expect(apollo).toBeTruthy();
    expect(apollo!.count).toBe(3);
    const dates = apollo!.emails.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("rebuildThreads", () => {
  test("пересобирает беседы без потери писем", () => {
    const before = listEmails({ accountId }).length;
    const processed = rebuildThreads(accountId);
    expect(processed).toBe(before);
    const groups = listThreadsGrouped({ accountId });
    const apollo = groups.find((g) => g.subject === "Проект Аполлон");
    expect(apollo!.count).toBe(3);
    const jku = groups.filter((g) => g.subject.startsWith("Уведомление о новом счете за ЖКУ"));
    expect(jku.length).toBe(2);
  });
});
