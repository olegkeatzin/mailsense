import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { initApp } from "../init.js";
import { closeDb, getDb } from "../db/index.js";
import { analysisResults, emails } from "../db/schema.js";
import {
  getAnalysis,
  getEmail,
  getSetting,
  insertAccount,
  insertEmail,
  setSetting,
  upsertAnalysis
} from "../repos.js";
import { runStartupMaintenance } from "./maintenance.js";

/**
 * Обслуживание данных выполняется один раз на версию: иначе при каждом старте
 * пересобирались бы все беседы и снимались статусы — на большом ящике это долго.
 */
let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-maint-"));
  // initApp сам запускает обслуживание — это и есть первый прогон.
  initApp({ dataDir: dir });
});

afterAll(() => {
  // На Windows открытый файл базы не удаляется — сначала закрываем соединение.
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог уберёт система */
  }
});

describe("обслуживание при старте", () => {
  test("при первом старте проставляет версию", () => {
    expect(getSetting("maintenance.version")).not.toBeNull();
  });

  test("повторный запуск пропускается", () => {
    const r = runStartupMaintenance();
    expect(r.ran).toBe(false);
    expect(r.resetStatuses).toBe(0);
    expect(r.rethreaded).toBe(0);
  });

  test("принудительный запуск выполняется снова", () => {
    // force нужен, когда починку надо повторить вручную после сбоя.
    const r = runStartupMaintenance(true);
    expect(r.ran).toBe(true);
  });

  test("смена версии запускает обслуживание заново", () => {
    setSetting("maintenance.version", "0");
    const r = runStartupMaintenance();
    expect(r.ran).toBe(true);
    expect(getSetting("maintenance.version")).not.toBe("0");
  });

  test("пустая база не мешает обслуживанию", () => {
    const r = runStartupMaintenance(true);
    expect(r.ran).toBe(true);
    expect(r.resetStatuses).toBe(0);
  });
});

/**
 * Одноразовая чистка пустых строк. Нормализация при записи (nullIfBlank)
 * новые такие значения не создаёт, но в базе остаются старые: фильтры их уже
 * игнорируют, а следующий фильтр может и не знать про эту особенность.
 */
describe("пустые строки в необязательных полях", () => {
  function emailWithBlankFields() {
    const accountId = insertAccount(
      {
        protocol: "imap",
        host: "mail.test",
        port: 993,
        tls: "ssl",
        username: "maint-" + randomUUID() + "@mail.test",
        authType: "login"
      },
      "enc"
    ).id;
    const email = insertEmail({
      accountId,
      folder: "INBOX",
      uid: "uid-" + randomUUID(),
      messageId: randomUUID() + "@test.local",
      subject: "Письмо из прошлой версии",
      from: { address: "sender@test.local" },
      to: [],
      date: "2026-01-15T10:00:00.000Z",
      bodyText: "текст",
      bodyHtml: null,
      headers: {}
    });
    upsertAnalysis({
      emailId: email.id,
      summary: "кратко",
      tags: [],
      priority: 3,
      urgent: false,
      eventDate: "2026-05-05",
      category: "work",
      rawResponse: "{}",
      modelUsed: "test"
    });
    // Симулируем данные, записанные ДО нормализации: пустые строки лежат в базе.
    getDb().update(emails).set({ externalNumber: "", sendDate: "" }).where(eq(emails.id, email.id)).run();
    getDb()
      .update(analysisResults)
      .set({ eventDate: "   " })
      .where(eq(analysisResults.emailId, email.id))
      .run();
    return email.id;
  }

  test("обслуживание превращает пустые значения в NULL и сообщает сколько исправило", () => {
    const emailId = emailWithBlankFields();

    const r = runStartupMaintenance(true);

    // Три поля: дата события, внешний номер, дата отправки.
    expect(r.normalizedBlanks).toBe(3);
    expect(getAnalysis(emailId)!.eventDate).toBeNull();
    expect(getEmail(emailId)!.externalNumber).toBeNull();
    expect(getEmail(emailId)!.sendDate).toBeNull();
  });

  test("повторный прогон уже ничего не находит", () => {
    const r = runStartupMaintenance(true);

    expect(r.ran).toBe(true);
    expect(r.normalizedBlanks).toBe(0);
  });

  test("настоящие значения чистка не задевает", () => {
    const accountId = insertAccount(
      {
        protocol: "imap",
        host: "mail.test",
        port: 993,
        tls: "ssl",
        username: "keep-" + randomUUID() + "@mail.test",
        authType: "login"
      },
      "enc"
    ).id;
    const email = insertEmail({
      accountId,
      folder: "INBOX",
      uid: "uid-" + randomUUID(),
      messageId: randomUUID() + "@test.local",
      subject: "С настоящими значениями",
      from: { address: "sender@test.local" },
      to: [],
      date: "2026-01-15T10:00:00.000Z",
      bodyText: "текст",
      bodyHtml: null,
      headers: {}
    });
    upsertAnalysis({
      emailId: email.id,
      summary: "кратко",
      tags: [],
      priority: 3,
      urgent: false,
      eventDate: "2026-06-06",
      category: "work",
      rawResponse: "{}",
      modelUsed: "test"
    });

    const r = runStartupMaintenance(true);

    expect(r.normalizedBlanks).toBe(0);
    expect(getAnalysis(email.id)!.eventDate).toBe("2026-06-06");
  });
});
