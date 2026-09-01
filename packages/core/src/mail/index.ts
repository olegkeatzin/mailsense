export { ImapConnector, createImapConnector } from "./imapConnector.js";
export { Pop3Connector } from "./pop3Connector.js";
export { Pop3Client } from "./pop3Client.js";
export type { MailConnector, RawMessage, MailConnectorFactory } from "./connector.js";
export { parseRawEmail, classifyKind } from "./parser.js";
export type { ParsedEmail, ParsedAttachment } from "./parser.js";
