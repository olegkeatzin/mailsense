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
  /** Причина аварии (таймаут/ошибка сокета): её видит ожидающий readLine(). */
  private failure: Error | null = null;

  constructor(private opts: Pop3ClientOptions) {}

  async connect(): Promise<void> {
    const { host, port, tls: mode, rejectUnauthorized } = this.opts;
    const raw =
      mode === "ssl"
        ? tls.connect({ host, port, rejectUnauthorized })
        : net.connect({ host, port });

    this.socket = raw;
    this.watch(raw);

    await this.waitConnect(raw);
    const greeting = await this.readLine();
    if (!greeting.startsWith("+OK")) throw new Error("POP3: нет приветствия: " + greeting);

    if (mode === "starttls") {
      await this.send("STLS");
      const line = await this.readLine();
      if (!line.startsWith("+OK")) throw new Error("POP3 STLS: " + line);
      this.buf = "";
      // С этого момента за тишину отвечает TLS-сокет. Таймер raw-сокета
      // выключаем: иначе он мог бы разорвать живой TLS-сеанс по своему счёту.
      raw.setTimeout(0);
      const tlsSocket = tls.connect({
        socket: raw,
        rejectUnauthorized,
        // ⚠️ servername с IP-адресом Node отвергает (ERR_INVALID_ARG_VALUE:
        // «Setting the TLS ServerName to an IP address is not permitted»), из-за чего
        // STARTTLS по IP не работал вообще ни у кого. SNI нужен только имени хоста —
        // без него не проверить сертификат по имени.
        ...(net.isIP(host) ? {} : { servername: host })
      });
      this.socket = tlsSocket;
      this.watch(tlsSocket);
      await this.waitConnect(tlsSocket);
    }
  }

  private notify(): void {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  /**
   * Навешивает обработчики сокета. Отдельно от connect(), потому что после STLS
   * работа идёт с другим сокетом — у него тоже должен быть таймаут.
   */
  private watch(sock: Socket): void {
    // ⚠️ setTimeout БЕЗ обработчика 'timeout' — это зависание навсегда: сокет
    // остаётся открытым, событие 'timeout' никем не слушается, readLine() ждёт
    // строку бесконечно, а скан аккаунта навсегда остаётся «в процессе»
    // (inFlightFetches в mailService не отпускает аккаунт до перезапуска).
    sock.setTimeout(this.opts.timeoutMs ?? 30000, () => {
      this.fail(
        new Error(
          `POP3: сервер ${this.opts.host}:${this.opts.port} не отвечает ${this.opts.timeoutMs ?? 30000} мс`
        )
      );
    });
    sock.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("latin1");
      this.notify();
    });
    sock.on("error", (err: Error) => {
      // Причину запоминаем: иначе ожидающий readLine() видит только «соединение
      // закрыто» и настоящая причина (ECONNRESET, EPIPE, таймаут) теряется.
      this.fail(err);
    });
    sock.on("close", () => {
      this.closed = true;
      this.notify();
    });
  }

  /** Аварийное завершение: запоминает причину, рвёт сокет и будит ожидающих. */
  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    this.closed = true;
    this.socket?.destroy();
    this.notify();
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
    const sock = this.socket;
    if (!sock) return;
    try {
      await this.send("QUIT");
      // Даём серверу ответить и закрыться штатно. destroy() рвёт соединение:
      // на той стороне это выглядит как ECONNRESET, а не как нормальное завершение.
      await Promise.race([
        this.readLine().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    } catch {
      /* соединение могло закрыться раньше */
    }
    sock.end();
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
      if (this.failure) throw this.failure;
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
