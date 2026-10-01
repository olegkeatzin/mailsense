import { ImapConnector } from "./imapConnector.js";
import type { Account } from "../types.js";

interface FetchQuery {
  source?: boolean;
  uid?: boolean;
}

/** Минимальный двойник ImapFlow: SEARCH отдаёт заданные UID, FETCH — сообщения. */
class FakeClient {
  public searches: Array<Record<string, unknown>> = [];
  public fetchedRanges: string[] = [];

  constructor(
    private allUids: number[],
    private failSearch = false
  ) {}

  getMailboxLock(): { release: () => void } {
    return { release: () => undefined };
  }

  async search(query: Record<string, unknown>): Promise<number[] | false> {
    if (this.failSearch) throw new Error("SEARCH failed");
    this.searches.push(query);
    return this.allUids;
  }

  fetch(range: string, _query: FetchQuery): AsyncGenerator<{ uid: number; source: Buffer }> {
    this.fetchedRanges.push(range);
    const uids = range === "1:*" ? this.allUids : range.split(",").map((n) => Number(n));
    return (async function* () {
      for (const uid of uids) {
        yield { uid, source: Buffer.from("Subject: test\r\n\r\nbody") };
      }
    })();
  }
}

function connectorWith(client: FakeClient): ImapConnector {
  const conn = new ImapConnector({} as Account);
  (conn as unknown as { client: unknown }).client = client;
  return conn;
}

describe("ImapConnector.fetchNew", () => {
  test("скачивает только неизвестные UID (известные не тянет с сервера)", async () => {
    const fake = new FakeClient([1, 2, 3, 4]);
    const conn = connectorWith(fake);

    const messages = await conn.fetchNew("INBOX", new Set(["1", "2"]));

    expect(fake.fetchedRanges).toEqual(["3,4"]);
    expect(messages.map((m) => m.uid)).toEqual(["3", "4"]);
  });

  test("если новых писем нет — не скачивает ничего и не виснет", async () => {
    const fake = new FakeClient([1, 2]);
    const conn = connectorWith(fake);

    const messages = await conn.fetchNew("INBOX", new Set(["1", "2"]));

    expect(fake.fetchedRanges).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("пустой ящик — пустой результат без FETCH", async () => {
    const fake = new FakeClient([]);
    const conn = connectorWith(fake);

    await expect(conn.fetchNew("INBOX", new Set())).resolves.toEqual([]);
    expect(fake.fetchedRanges).toEqual([]);
  });

  test("передаёт диапазон дат в SEARCH (SENTSINCE/SENTBEFORE)", async () => {
    const fake = new FakeClient([7]);
    const conn = connectorWith(fake);

    await conn.fetchNew("INBOX", new Set(), {
      since: new Date("2026-09-01T00:00:00"),
      until: new Date("2026-09-02T23:59:59")
    });

    expect(fake.searches[0].sentSince).toBeInstanceOf(Date);
    expect(fake.searches[0].sentBefore).toBeInstanceOf(Date);
  });

  test("UID-набор шлётся пачками", async () => {
    const all = Array.from({ length: 1200 }, (_, i) => i + 1);
    const fake = new FakeClient(all);
    const conn = connectorWith(fake);

    await conn.fetchNew("INBOX", new Set());

    expect(fake.fetchedRanges.map((r) => r.split(",").length)).toEqual([500, 500, 200]);
  });

  test("если SEARCH не удался — фолбэк на весь ящик с клиентским фильтром", async () => {
    const fake = new FakeClient([1, 2, 3], true);
    const conn = connectorWith(fake);

    const messages = await conn.fetchNew("INBOX", new Set(["1"]));

    expect(fake.fetchedRanges).toEqual(["1:*"]);
    expect(messages.map((m) => m.uid)).toEqual(["2", "3"]);
  });
});
