import type { Account } from "../types.js";
import type { FetchOptions, MailConnector, RawMessage } from "./connector.js";
import { Pop3Client } from "./pop3Client.js";
import { logger } from "../logger.js";

export class Pop3Connector implements MailConnector {
  private client: Pop3Client | null = null;

  constructor(
    private account: Account,
    private passwordDecrypted: string
  ) {}

  async connect(): Promise<void> {
    const a = this.account;
    this.client = new Pop3Client({
      host: a.host,
      port: a.port,
      tls: a.tls,
      username: a.username,
      password: this.passwordDecrypted,
      rejectUnauthorized: a.settings.rejectUnauthorized === true
    });
    await this.client.connect();
    await this.client.login();
    logger.info({ host: a.host, port: a.port }, "POP3 подключён");
  }

  async fetchNew(_folder: string, knownUids: Set<string>, _opts?: FetchOptions): Promise<RawMessage[]> {
    if (!this.client) throw new Error("POP3: не подключён");
    const refs = await this.client.uidl();
    const out: RawMessage[] = [];
    for (const ref of refs) {
      if (knownUids.has(ref.uid)) continue;
      const source = await this.client.retrieve(ref.num);
      out.push({ uid: ref.uid, source });
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
