import type { Account, AccountInput } from "../types.js";
import { getContext } from "../context.js";
import {
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  updateAccount
} from "../repos.js";
import { createImapConnector } from "../mail/imapConnector.js";
import { Pop3Connector } from "../mail/pop3Connector.js";
import type { MailConnector } from "../mail/connector.js";

export function getAccounts(): Account[] {
  return listAccounts();
}

export function getAccountById(id: string): Account | null {
  return getAccount(id);
}

export function createAccount(input: AccountInput): Account {
  const secrets = getContext().secrets;
  if (!input.password) throw new Error("Не указан пароль");
  return insertAccount(
    input,
    secrets.encrypt(input.password),
    input.smtpPassword ? secrets.encrypt(input.smtpPassword) : null
  );
}

export function updateAccountById(id: string, input: AccountInput): Account | null {
  const secrets = getContext().secrets;
  const enc = input.password ? secrets.encrypt(input.password) : undefined;
  const smtpEnc = input.smtpPassword ? secrets.encrypt(input.smtpPassword) : undefined;
  return updateAccount(id, input, enc, smtpEnc);
}

export function removeAccount(id: string): void {
  deleteAccount(id);
}

export function decryptPassword(account: Account): string {
  return getContext().secrets.decrypt(account.passwordEncrypted);
}

/** Пароль SMTP: отдельный, если задан; иначе fallback на пароль IMAP. */
export function decryptSmtpPassword(account: Account): string {
  if (account.smtpPasswordEncrypted) {
    return getContext().secrets.decrypt(account.smtpPasswordEncrypted);
  }
  return decryptPassword(account);
}

export function buildConnector(account: Account, password: string): MailConnector {
  if (account.protocol === "imap") return createImapConnector(account, password);
  return new Pop3Connector(account, password);
}

export async function testConnection(input: AccountInput): Promise<{ ok: boolean; error?: string }> {
  if (!input.password) return { ok: false, error: "Не указан пароль" };
  const fake: Account = {
    id: "test",
    protocol: input.protocol,
    host: input.host,
    port: input.port,
    tls: input.tls,
    username: input.username,
    passwordEncrypted: "",
    authType: input.authType,
    settings: input.settings ?? {},
    smtpHost: input.smtpHost ?? null,
    smtpPort: input.smtpPort ?? null,
    smtpTls: input.smtpTls ?? null,
    smtpUsername: input.smtpUsername ?? null,
    smtpPasswordEncrypted: "",
    smtpAuthType: input.smtpAuthType ?? null,
    createdAt: "",
    updatedAt: ""
  };
  const connector = buildConnector(fake, input.password);
  try {
    await connector.connect();
    await connector.disconnect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
