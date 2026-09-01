import type { Account } from "../types.js";

export interface RawMessage {
  uid: string;
  source: Buffer;
}

export interface FetchOptions {
  since?: Date;
  until?: Date;
}

export interface MailConnector {
  connect(): Promise<void>;
  fetchNew(folder: string, knownUids: Set<string>, opts?: FetchOptions): Promise<RawMessage[]>;
  disconnect(): Promise<void>;
}

export type MailConnectorFactory = (account: Account) => MailConnector;
