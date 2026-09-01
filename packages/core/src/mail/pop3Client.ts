import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";

export type Pop3Tls = "none" | "ssl" | "starttls";

export interface Pop3ClientOptions {
  host: string;
  port: number;
  tls: Pop3Tls;
  username: string;
  password: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

export interface Pop3MessageRef {
  num: number;
  uid: string;
}

/**
 * Минимальный POP3-клиент (без внешних зависимостей).
 * Поддержка: plain, implicit TLS (ssl), STARTTLS (STLS), USER/PASS, UIDL, RETR.
 */
export class Pop3Client {
  private socket: Socket | null = null;
  private buf = "";
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private opts: Pop3ClientOptions) {}

  async connect(): Promise<void> {
    const { host, port, tls: mode, rejectUnauthorized } = this.opts;
    const raw =
      mode === "ssl"
        ? tls.connect({ host, port, rejectUnauthorized })
        : net.connect({ host, port });

    this.socket = raw;
    raw.setTimeout(this.opts.timeoutMs ?? 30000);
    raw.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("latin1");
      this.notify();
    });
    raw.on("error", () => {
      this.closed = true;
    });
    raw.on("close", () => {
      this.closed = true;
      this.notify();
    });

    await this.waitConnect(raw);
    const greeting = await this.readLine();
    if (!greeting.startsWith("+OK")) throw new Error("POP3: нет приветствия: " + greeting);

    if (mode === "starttls") {
      await this.send("STLS");
      const line = await this.readLine();
      if (!line.startsWith("+OK")) throw new Error("POP3 STLS: " + line);
      this.buf = "";
      const tlsSocket = tls.connect({
        socket: raw,
        rejectUnauthorized,
        servername: host
      });
      this.socket = tlsSocket;
      tlsSocket.on("data", (chunk: Buffer) => {
        this.buf += chunk.toString("latin1");
        this.notify();
      });
      await this.waitConnect(tlsSocket);
    }
  }

  private notify(): void {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  private waitConnect(sock: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      if (sock.connecting === false) return resolve();
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
  }

  async login(): Promise<void> {
    await this.send("USER " + this.opts.username);
    let line = await this.readLine();
    if (!line.startsWith("+OK")) throw new Error("POP3 USER: " + line);
    await this.send("PASS " + this.opts.password);
    line = await this.readLine();
    if (!line.startsWith("+OK")) throw new Error("POP3 PASS: неверный логин/пароль");
  }

  async uidl(): Promise<Pop3MessageRef[]> {
    await this.send("UIDL");
    const status = await this.readLine();
    if (!status.startsWith("+OK")) throw new Error("POP3 UIDL: " + status);
    const lines = await this.readMultiLine();
    const refs: Pop3MessageRef[] = [];
    for (const line of lines) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) refs.push({ num: Number(m[1]), uid: m[2] });
    }
    return refs;
  }

  async retrieve(num: number): Promise<Buffer> {
    await this.send("RETR " + num);
    const status = await this.readLine();
    if (!status.startsWith("+OK")) throw new Error("POP3 RETR: " + status);
    const lines = await this.readMultiLine();
    return Buffer.from(lines.join("\r\n") + "\r\n", "latin1");
  }

  async quit(): Promise<void> {
    try {
      await this.send("QUIT");
    } catch {
      /* ignore */
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private send(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("POP3: не подключён"));
      this.socket.write(cmd + "\r\n", (err) => (err ? reject(err) : resolve()));
    });
  }

  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return line;
      }
      if (this.closed) throw new Error("POP3: соединение закрыто");
      await this.waitData();
    }
  }

  private async readMultiLine(): Promise<string[]> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      if (line === ".") break;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return lines;
  }

  private waitData(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
