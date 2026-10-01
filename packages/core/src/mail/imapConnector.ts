import { ImapFlow } from "imapflow";
import type { Account } from "../types.js";
import type { FetchOptions, MailConnector, MailboxInfo, RawMessage } from "./connector.js";
import { logger } from "../logger.js";

/** Размер пачки UID в одном FETCH (страховка от слишком длинной строки команды). */
const UID_BATCH_SIZE = 500;

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

  /**
   * Возвращает UID-список выборки: по диапазону дат — SEARCH SENTSINCE/SENTBEFORE
   * (дата из заголовка Date), без диапазона — SEARCH ALL. Пустой массив означает
   * «совпадений нет»; null — серверный поиск не удался (нужен фолбэк на весь ящик).
   *
   * Почему не через `since`/`before` у fetch: ImapFlow компилирует BEFORE/SINCE в
   * расширение WITHIN (OLDER/YOUNGER), которое Dovecot отвергает («Invalid search
   * interval parameter»), из-за чего сканы по диапазону молча не находили писем.
   */
  private async resolveUids(opts?: FetchOptions): Promise<string[] | null> {
    const query: Record<string, unknown> = {};
    if (opts?.since) query.sentSince = opts.since;
    // SENTBEFORE эксклюзивен по дате — сдвигаем на сутки, чтобы включить конечный день.
    if (opts?.until) query.sentBefore = new Date(opts.until.getTime() + 24 * 60 * 60 * 1000);
    try {
      const uids = await this.client!.search(query, { uid: true });
      if (Array.isArray(uids)) return uids.map((u) => String(u));
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "IMAP: серверный поиск UID не удался, выгружаем весь ящик"
      );
    }
    return null;
  }

  async fetchNew(folder: string, knownUids: Set<string>, opts?: FetchOptions): Promise<RawMessage[]> {
    if (!this.client) throw new Error("IMAP: не подключён");
    const mailbox = folder || "INBOX";
    const lock = await this.client.getMailboxLock(mailbox);
    const out: RawMessage[] = [];
    try {
      // Сначала получаем только UID-ы и отсеиваем известные, и лишь затем качаем
      // тела. Раньше выборка "1:*" тянула с сервера ВСЕ письма (включая тысячи
      // уже сохранённых) — скан без периода выглядел бесконечно загружающимся.
      const uids = await this.resolveUids(opts);
      if (uids) {
        const unknown = uids.filter((uid) => !knownUids.has(uid));
        // Пачками: строка UID-набора не должна превышать лимит IMAP-команды.
        for (let i = 0; i < unknown.length; i += UID_BATCH_SIZE) {
          const batch = unknown.slice(i, i + UID_BATCH_SIZE).join(",");
          // Для списка UID обязателен options.uid=true.
          for await (const msg of this.client.fetch(batch, { source: true, uid: true }, { uid: true })) {
            if (!msg.source) continue;
            out.push({ uid: String(msg.uid), source: msg.source });
          }
        }
        return out;
      }
      // Серверный поиск не удался — выгружаем весь ящик и фильтруем на клиенте.
      for await (const msg of this.client.fetch("1:*", { source: true, uid: true })) {
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
