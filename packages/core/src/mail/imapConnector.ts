import { ImapFlow } from "imapflow";
import type { Account } from "../types.js";
import type { FetchOptions, MailConnector, MailboxInfo, RawMessage } from "./connector.js";
import { logger } from "../logger.js";

export class ImapConnector implements MailConnector {
  private client: ImapFlow | null = null;

  constructor(private account: Account) {}

  async connect(): Promise<void> {
    const a = this.account;
    const secure = a.tls === "ssl";
    this.client = new ImapFlow({
      host: a.host,
      port: a.port,
      secure,
      auth: { user: a.username, pass: this.password },
      logger: false,
      tls: { rejectUnauthorized: a.settings.rejectUnauthorized === true }
    });
    await this.client.connect();
    logger.info({ host: a.host, port: a.port }, "IMAP подключён");
  }

  private get password(): string {
    return (this.account as Account & { passwordDecrypted?: string }).passwordDecrypted ?? "";
  }

  async fetchNew(folder: string, knownUids: Set<string>, opts?: FetchOptions): Promise<RawMessage[]> {
    if (!this.client) throw new Error("IMAP: не подключён");
    const mailbox = folder || "INBOX";
    const lock = await this.client.getMailboxLock(mailbox);
    const out: RawMessage[] = [];
    try {
      // Полная выгрузка ящика или фильтр по датам (IMAP SINCE/BEFORE).
      let range: string | Record<string, unknown> = "1:*";
      if (opts?.since || opts?.until) {
        range = {};
        if (opts.since) (range as Record<string, unknown>).since = opts.since;
        if (opts.until) (range as Record<string, unknown>).before = opts.until;
      }
      const messages = this.client.fetch(range as never, { source: true, uid: true });
      for await (const msg of messages) {
        const uid = String(msg.uid);
        if (knownUids.has(uid)) continue;
        if (!msg.source) continue;
        out.push({ uid, source: msg.source });
      }
    } finally {
      lock.release();
    }
    return out;
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    if (!this.client) throw new Error("IMAP: не подключён");
    const list = await this.client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      specialUse: typeof m.specialUse === "string" ? m.specialUse : undefined
    }));
  }

  async appendRaw(folder: string, raw: Buffer, flags?: string[]): Promise<void> {
    if (!this.client) throw new Error("IMAP: не подключён");
    await this.client.append(folder, raw, flags ?? ["\\Seen"], new Date());
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}

/** Фабрика: привязывает расшифрованный пароль к коннектору. */
export function createImapConnector(account: Account, passwordDecrypted: string): ImapConnector {
  const acc = { ...account } as Account & { passwordDecrypted?: string };
  acc.passwordDecrypted = passwordDecrypted;
  return new ImapConnector(acc);
}
