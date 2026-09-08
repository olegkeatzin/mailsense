import type { Account } from "../types.js";

export interface RawMessage {
  uid: string;
  source: Buffer;
}

export interface FetchOptions {
  since?: Date;
  until?: Date;
}

export interface MailboxInfo {
  path: string;
  name: string;
  specialUse?: string;
}

export interface MailConnector {
  connect(): Promise<void>;
  fetchNew(folder: string, knownUids: Set<string>, opts?: FetchOptions): Promise<RawMessage[]>;
  /** Список папок (только IMAP). */
  listMailboxes?(): Promise<MailboxInfo[]>;
  /** Сохранить письмо в папку на сервере (только IMAP). */
  appendRaw?(folder: string, raw: Buffer, flags?: string[]): Promise<void>;
  disconnect(): Promise<void>;
}

export type MailConnectorFactory = (account: Account) => MailConnector;
