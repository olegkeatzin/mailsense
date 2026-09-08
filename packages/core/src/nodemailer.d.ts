declare module "nodemailer" {
  export interface Attachment {
    filename?: string;
    content?: string | Buffer;
    contentType?: string;
    path?: string;
  }

  export interface MailOptions {
    from?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    attachments?: Attachment[];
    inReplyTo?: string;
    references?: string;
    messageId?: string;
    raw?: string | Buffer;
  }

  export interface SentMessageInfo {
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    response?: string;
    envelope?: Record<string, unknown>;
    message?: Buffer | string;
  }

  export interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user?: string; pass?: string };
    tls?: { rejectUnauthorized?: boolean };
    streamTransport?: boolean;
    buffer?: boolean;
    newline?: string;
  }

  export interface Transporter {
    sendMail(mail: MailOptions): Promise<SentMessageInfo>;
    verify(): Promise<boolean>;
    close(): void;
  }

  export function createTransport(options: TransportOptions): Transporter;

  const nodemailer: {
    createTransport(options: TransportOptions): Transporter;
  };
  export default nodemailer;
}