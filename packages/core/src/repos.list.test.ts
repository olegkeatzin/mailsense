import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Список писем с анализом — самый горячий путь чтения: он открывается на каждом
 * обращении к «Почте», «Переписке» и журналу входящих. Раньше на каждое письмо
 * делался отдельный запрос за анализом (N+1), поэтому список из 500 писем
 * означал 501 запрос к SQLite. Здесь считается само число запросов — оно не
 * должно зависеть от размера ящика.
 *
 * Фильтры по тексту (поиск, отправитель, получатель, теги, внешний номер)
 * намеренно остаются в JS: SQLite умеет складывать регистр только по ASCII,
 * и «иван» перестал бы находить «Иванов» (см. searchContactsCache в repos.ts).
 */
import { eq } from "drizzle-orm";
import { initApp } from "./init.js";
import { closeDb, getDb } from "./db/index.js";
import { analysisResults } from "./db/schema.js";
import {
  countAttachmentsByEmail,
  getAnalysis,
  insertAccount,
  insertAttachment,
  insertEmail,
  listEmailsWithAnalysis,
  listEmailsWithAnalysisByThreadIds,
  setEmailStatus,
  setExternalNumber,
  setSendDate,
  upsertAnalysis
} from "./repos.js";
import { NodeSecretStore } from "./secrets.js";
import type { Category } from "./types.js";

let dir = "";
let accountId = "";
let otherAccountId = "";
let uid = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-list-"));
  initApp({ dataDir: dir });
  const secrets = new NodeSecretStore(dir);
  const base = {
    protocol: "imap" as const,
    host: "mail.test",
    port: 993,
    tls: "ssl" as const,
    authType: "login" as const,
    password: "p"
  };
  accountId = insertAccount({ ...base, username: "list@mail.test" }, secrets.encrypt("p")).id;
  otherAccountId = insertAccount({ ...base, username: "other@mail.test" }, secrets.encrypt("p")).id;
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

/** Счётчик SQL-запросов: drizzle пишет каждый запрос в свой логгер. */
function countQueries<T>(fn: () => T): { result: T; queries: string[] } {
  const session = (getDb() as unknown as {
    session: { logger: { logQuery: (sql: string) => void } };
  }).session;
  const previous = session.logger;
  const queries: string[] = [];
  session.logger = { logQuery: (sql: string) => queries.push(sql) };
  try {
    return { result: fn(), queries };
  } finally {
    session.logger = previous;
  }
}

function addEmail(over: {
  accountId?: string;
  folder?: string;
  subject?: string;
  date?: string | null;
  from?: { name?: string; address: string };
  to?: Array<{ name?: string; address: string }>;
  externalNumber?: string | null;
  body?: string;
  threadId?: string;
} = {}) {
  uid++;
  return insertEmail({
    accountId: over.accountId ?? accountId,
    folder: over.folder ?? "INBOX",
    uid: "uid-" + uid,
    messageId: "msg-" + uid + "@test.local",
    subject: over.subject ?? "Письмо " + uid,
    from: over.from ?? { name: "Отправитель", address: "sender@test.local" },
    to: over.to ?? [{ address: "me@test.local" }],
    date: over.date === undefined ? "2026-09-01T10:00:00.000Z" : over.date,
    bodyText: over.body ?? "тело письма",
    bodyHtml: null,
    headers: {},
    externalNumber: over.externalNumber ?? null,
    threadId: over.threadId ?? null
  });
}

function addAnalysis(
  emailId: string,
  over: Partial<{
    category: Category;
    priority: number;
    tags: string[];
    eventDate: string | null;
    urgent: boolean;
    summary: string;
  }> = {}
) {
  return upsertAnalysis({
    emailId,
    summary: over.summary ?? "кратко",
    tags: over.tags ?? ["акт"],
    priority: over.priority ?? 3,
    urgent: over.urgent ?? false,
    eventDate: over.eventDate ?? null,
    category: over.category ?? "personal",
    rawResponse: "{}",
    modelUsed: "test"
  });
}

describe("listEmailsWithAnalysis: число запросов", () => {
  test("не зависит от числа писем в ящике", () => {
    const few: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = addEmail({ subject: "Мало " + i });
      addAnalysis(e.id);
      few.push(e.id);
    }
    const small = countQueries(() => listEmailsWithAnalysis({ accountId, folder: "INBOX" }));
    expect(small.result).toHaveLength(3);

    const many: string[] = [];
    for (let i = 0; i < 30; i++) {
      const e = addEmail({ subject: "Много " + i });
      addAnalysis(e.id);
      many.push(e.id);
    }
    const big = countQueries(() => listEmailsWithAnalysis({ accountId, folder: "INBOX" }));

    expect(big.result).toHaveLength(33);
    // Писем стало в 10 раз больше — запросов столько же.
    expect(big.queries).toHaveLength(small.queries.length);
    // Один запрос на письма + анализ. Больше — уже N+1.
    expect(big.queries.length).toBeLessThanOrEqual(2);
  });

  test("письма без анализа не теряются и дают analysis = null", () => {
    const withAnalysis = addEmail({ subject: "С анализом" });
    addAnalysis(withAnalysis.id);
    const without = addEmail({ subject: "Без анализа" });

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX" });
    const a = items.find((i) => i.id === withAnalysis.id)!;
    const b = items.find((i) => i.id === without.id)!;

    expect(a.analysis?.summary).toBe("кратко");
    expect(b.analysis).toBeNull();
  });

  test("в выборку попадают только письма своего ящика и папки", () => {
    const foreign = addEmail({ accountId: otherAccountId, subject: "Чужое" });
    addAnalysis(foreign.id);
    const sent = addEmail({ folder: "Sent", subject: "Отправленное" });
    addAnalysis(sent.id);

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX" });
    expect(items.some((i) => i.id === foreign.id)).toBe(false);
    expect(items.some((i) => i.id === sent.id)).toBe(false);
  });

  test("результат совпадает с поштучным чтением анализа", () => {
    // Защита от расхождения JOIN и одиночного запроса.
    for (const item of listEmailsWithAnalysis({ accountId, folder: "INBOX" })) {
      expect(item.analysis).toEqual(getAnalysis(item.id));
    }
  });
});

describe("пустая строка вместо даты события", () => {
  test("запись анализа с event_date = \"\" кладёт в базу NULL", () => {
    const email = addEmail({ folder: "HasEvent", subject: "Пустая дата" });

    addAnalysis(email.id, { eventDate: "" });

    // Пустая строка — не дата. Иначе она уходит в базу и живёт там как значение.
    expect(getAnalysis(email.id)!.eventDate).toBeNull();
  });

  test("строка из пробелов тоже сохраняется как отсутствие даты", () => {
    const email = addEmail({ folder: "HasEvent", subject: "Пробелы вместо даты" });

    addAnalysis(email.id, { eventDate: "   " });

    expect(getAnalysis(email.id)!.eventDate).toBeNull();
  });

  test("фильтр «есть дата события» не считает пустую строку датой", () => {
    const email = addEmail({ folder: "HasEvent", subject: "Наследие: пустая дата" });
    addAnalysis(email.id, { eventDate: "2026-04-01" });
    // Симулируем запись, сделанную до правки: пустая строка уже лежит в базе.
    // Нормализация при записи такие строки больше не создаёт, но старые данные
    // остаются — фильтр обязан их игнорировать.
    getDb()
      .update(analysisResults)
      .set({ eventDate: "" })
      .where(eq(analysisResults.emailId, email.id))
      .run();

    const items = listEmailsWithAnalysis({ accountId, folder: "HasEvent", hasEvent: true });

    expect(items.some((i) => i.id === email.id)).toBe(false);
  });

  test("настоящая дата в фильтр попадает", () => {
    const email = addEmail({ folder: "HasEvent", subject: "С датой" });
    addAnalysis(email.id, { eventDate: "2026-04-02" });

    const items = listEmailsWithAnalysis({ accountId, folder: "HasEvent", hasEvent: true });

    expect(items.some((i) => i.id === email.id)).toBe(true);
  });

  test("соседние необязательные поля тоже не хранят пустую строку", () => {
    const email = addEmail({ folder: "HasEvent", subject: "Пустые поля" });

    setExternalNumber(email.id, "");
    setSendDate(email.id, "");

    const saved = listEmailsWithAnalysis({ accountId, folder: "HasEvent" }).find((i) => i.id === email.id)!;
    expect(saved.externalNumber).toBeNull();
    expect(saved.sendDate).toBeNull();
  });
});

describe("countAttachmentsByEmail", () => {
  function addAttachment(emailId: string, filename: string) {
    return insertAttachment({
      emailId,
      filename,
      mimeType: "text/plain",
      size: 3,
      storagePath: null,
      extractedText: null,
      contentId: null,
      kind: "text",
      handled: true
    });
  }

  test("считает вложения по каждому письму одним запросом", () => {
    const two = addEmail({ folder: "Counts", subject: "С двумя вложениями" });
    addAttachment(two.id, "a.txt");
    addAttachment(two.id, "b.txt");
    const one = addEmail({ folder: "Counts", subject: "С одним" });
    addAttachment(one.id, "c.txt");
    const none = addEmail({ folder: "Counts", subject: "Без вложений" });

    const { result, queries } = countQueries(() =>
      countAttachmentsByEmail([two.id, one.id, none.id])
    );

    expect(result.get(two.id)).toBe(2);
    expect(result.get(one.id)).toBe(1);
    // Письма без вложений в мапе нет — вызывающий приводит к нулю.
    expect(result.has(none.id)).toBe(false);
    // Три письма — один запрос, а не три (это была бы та самая N+1).
    expect(queries).toHaveLength(1);
  });

  test("пустой список писем не ходит в базу", () => {
    const { result, queries } = countQueries(() => countAttachmentsByEmail([]));
    expect(result.size).toBe(0);
    expect(queries).toEqual([]);
  });

  test("чужие идентификаторы не влияют на счёт", () => {
    const email = addEmail({ folder: "Counts", subject: "Одно" });
    addAttachment(email.id, "d.txt");

    const res = countAttachmentsByEmail([email.id, "нет-такого-письма"]);

    expect(res.size).toBe(1);
    expect(res.get(email.id)).toBe(1);
  });
});

describe("listEmailsWithAnalysis: фильтры и сортировка", () => {
  test("по категории", () => {
    const work = addEmail({ subject: "Счёт на оплату" });
    addAnalysis(work.id, { category: "work" });
    const spam = addEmail({ subject: "Реклама" });
    addAnalysis(spam.id, { category: "spam" });

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX", categories: ["work"] });
    expect(items.map((i) => i.id)).toEqual([work.id]);
  });

  test("по минимальному приоритету", () => {
    const high = addEmail({ subject: "Срочное" });
    addAnalysis(high.id, { priority: 5, urgent: true });
    const low = addEmail({ subject: "Не срочное" });
    addAnalysis(low.id, { priority: 1 });

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX", minPriority: 4 });
    expect(items.map((i) => i.id)).toEqual([high.id]);
  });

  test("только письма с датой события", () => {
    const event = addEmail({ subject: "Совещание" });
    addAnalysis(event.id, { eventDate: "2026-10-01" });

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX", hasEvent: true });
    expect(items.map((i) => i.id)).toEqual([event.id]);
  });

  test("по статусу анализа", () => {
    const done = addEmail({ subject: "Готово" });
    addAnalysis(done.id);
    setEmailStatus(done.id, "ready");

    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX", status: "ready" });
    expect(items.map((i) => i.id)).toEqual([done.id]);
  });

  test("поиск по тексту не теряет кириллицу в другом регистре", () => {
    const letter = addEmail({ subject: "Договор поставки", body: "просим подписать" });
    addAnalysis(letter.id);

    // SQLite LIKE/SQL lower() складывает регистр только по ASCII — фильтр
    // обязан остаться в JS, иначе «договор» не находит «Договор».
    const items = listEmailsWithAnalysis({ accountId, folder: "INBOX", q: "договор" });
    expect(items.map((i) => i.id)).toEqual([letter.id]);
  });

  test("поиск по отправителю, тегу и внешнему номеру", () => {
    const a = addEmail({
      subject: "Письмо от Иванова",
      from: { name: "Иванов Иван", address: "ivanov@test.local" },
      externalNumber: "вх1024"
    });
    addAnalysis(a.id, { tags: ["Налоговая"] });

    expect(listEmailsWithAnalysis({ accountId, folder: "INBOX", from: ["иванов"] }).map((i) => i.id)).toEqual([a.id]);
    expect(listEmailsWithAnalysis({ accountId, folder: "INBOX", tag: "налогов" }).map((i) => i.id)).toEqual([a.id]);
    expect(
      listEmailsWithAnalysis({ accountId, folder: "INBOX", externalNumber: ["ВХ1024"] }).map((i) => i.id)
    ).toEqual([a.id]);
  });

  test("фильтр по получателю", () => {
    const a = addEmail({ subject: "Копия", to: [{ name: "Петров", address: "petrov@test.local" }] });
    addAnalysis(a.id);
    expect(listEmailsWithAnalysis({ accountId, folder: "INBOX", to: ["петров"] }).map((i) => i.id)).toEqual([a.id]);
  });

  test("диапазон дат получения", () => {
    const inside = addEmail({ subject: "Внутри", date: "2026-03-15T10:00:00.000Z" });
    addAnalysis(inside.id);
    const outside = addEmail({ subject: "Снаружи", date: "2025-12-31T10:00:00.000Z" });
    addAnalysis(outside.id);
    const noDate = addEmail({ subject: "Без даты", date: null });
    addAnalysis(noDate.id);

    const items = listEmailsWithAnalysis({
      accountId,
      folder: "INBOX",
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31"
    });
    expect(items.map((i) => i.id)).toEqual([inside.id]);
  });

  test("диапазон дат отправки", () => {
    // sendDate проставляется отдельно (в insertEmail его нет).
    const inside = addEmail({ subject: "Отправлено" });
    addAnalysis(inside.id);
    setSendDate(inside.id, "2026-04-10");
    const outside = addEmail({ subject: "Не отправлено" });
    addAnalysis(outside.id);
    setSendDate(outside.id, "2026-04-20");

    const items = listEmailsWithAnalysis({
      accountId,
      folder: "INBOX",
      sendDateFrom: "2026-04-01",
      sendDateTo: "2026-04-15"
    });
    expect(items.map((i) => i.id)).toEqual([inside.id]);
  });

  test("сортировка по приоритету и по дате", () => {
    // Отдельная папка: в INBOX уже лежат письма других тестов.
    const urgent = addEmail({ folder: "Sorted", subject: "Высокий", date: "2026-05-01T10:00:00.000Z" });
    addAnalysis(urgent.id, { priority: 5 });
    const normal = addEmail({ folder: "Sorted", subject: "Низкий", date: "2026-05-02T10:00:00.000Z" });
    addAnalysis(normal.id, { priority: 1 });

    const byPriority = listEmailsWithAnalysis({
      accountId,
      folder: "Sorted",
      sortBy: "priority",
      sortDir: "desc"
    });
    expect(byPriority.map((i) => i.id)).toEqual([urgent.id, normal.id]);

    const byDateAsc = listEmailsWithAnalysis({ accountId, folder: "Sorted", sortDir: "asc" });
    expect(byDateAsc.map((i) => i.id)).toEqual([urgent.id, normal.id]);
  });
});

describe("listEmailsWithAnalysisByThreadIds", () => {
  test("беседа собирается одним запросом с анализом", () => {
    const t = addEmail({ subject: "Переписка 1", threadId: "thread-a" });
    addAnalysis(t.id, { summary: "первое" });
    const t2 = addEmail({ subject: "Re: Переписка 1", threadId: "thread-a" });
    addAnalysis(t2.id, { summary: "второе" });

    const { result, queries } = countQueries(() => listEmailsWithAnalysisByThreadIds(["thread-a"]));

    expect(result.map((i) => i.id)).toEqual([t.id, t2.id]);
    expect(result.map((i) => i.analysis?.summary)).toEqual(["первое", "второе"]);
    // Два письма — не два запроса за анализом.
    expect(queries.length).toBeLessThanOrEqual(2);
  });

  test("пустой список бесед не ходит в базу", () => {
    const { result, queries } = countQueries(() => listEmailsWithAnalysisByThreadIds([]));
    expect(result).toEqual([]);
    expect(queries).toEqual([]);
  });
});