import net from "node:net";

/**
 * Мини-SMTP для сквозных тестов: принимает письмо целиком и складывает в messages.
 *
 * Это «адресат»: единственный способ доказать, что вложение реально ушло, — посмотреть,
 * что пришло на другой конец SMTP-соединения. Ноды сети наружу не нужны.
 */
export interface FakeSmtp {
  port: number;
  /** Принятые письма (сырой MIME без завершающей точки). */
  messages: Buffer[];
  close(): Promise<void>;
}

export async function startSmtp(): Promise<FakeSmtp> {
  const messages: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let collecting = false;
    let message = Buffer.alloc(0);
    socket.write("220 mailsense-test ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (collecting) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) {
          message = Buffer.concat([message, buffer]);
          buffer = Buffer.alloc(0);
          return;
        }
        // Письмо у адресата: точка — конец DATA, её в тело не включаем.
        messages.push(Buffer.concat([message, buffer.subarray(0, end)]));
        buffer = buffer.subarray(end + 5);
        message = Buffer.alloc(0);
        collecting = false;
        socket.write("250 2.0.0 Ok: queued\r\n");
      }
      let nl = buffer.indexOf("\r\n");
      while (!collecting && nl >= 0) {
        const line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 2);
        const command = line.split(" ")[0].toUpperCase();
        if (command === "EHLO" || command === "HELO") {
          // AUTH не объявляем: nodemailer тогда его и не пытается.
          socket.write("250-mailsense-test\r\n250 SIZE 104857600\r\n");
        } else if (command === "MAIL" || command === "RCPT") {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (command === "DATA") {
          collecting = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          break;
        } else if (command === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
        nl = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** Имя вложения из MIME: не-ASCII nodemailer кодирует по RFC 2231 и режет на продолжения. */
export function attachmentName(header: string): string {
  const chunks: string[] = [];
  const re = /filename\*(\d+)\*=([^\r\n;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) chunks[Number(m[1])] = m[2];
  if (chunks.length) return decodeURIComponent(chunks.filter(Boolean).join("").replace(/^utf-8''/i, ""));
  const plain = /filename="?([^"\r\n;]+)"?/.exec(header);
  return plain ? plain[1] : "";
}

/** Вложения из принятого письма: имя и раскодированные байты. */
export function parseAttachments(mime: string): Array<{ name: string; data: Buffer }> {
  return mime
    .split(/Content-Disposition: attachment/i)
    .slice(1)
    .map((chunk) => {
      const headerEnd = chunk.indexOf("\r\n\r\n");
      const header = headerEnd >= 0 ? chunk.slice(0, headerEnd) : chunk;
      const body = headerEnd >= 0 ? chunk.slice(headerEnd + 4) : "";
      const payload = body.split(/\r\n--/)[0].replace(/\r?\n/g, "");
      return { name: attachmentName(header), data: Buffer.from(payload, "base64") };
    });
}
