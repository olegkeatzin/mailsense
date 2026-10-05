import net from "node:net";
import { Pop3Client } from "./pop3Client.js";

/**
 * POP3-клиент собственной реализации, поэтому проверяем его на настоящем сокете
 * с поддельным сервером. Главная ловушка задокументирована в AGENTS.md: после
 * RETR/UIDL сначала приходит строка статуса «+OK …», и её нельзя вклеивать в тело.
 */
interface FakeOptions {
  uidls?: Array<{ num: number; uid: string }>;
  messages?: Record<number, Buffer>;
  rejectPass?: boolean;
  noGreeting?: boolean;
}

function startFakeServer(opts: FakeOptions) {
  const received: string[] = [];
  // Ошибки сокета со стороны сервера: нужны тесту quit(), иначе проверка тавтологична.
  const errors: string[] = [];
  const opened = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Обрыв на стороне клиента не должен валить тест необработанным исключением.
    socket.on("error", (e) => errors.push((e as NodeJS.ErrnoException).code ?? "unknown"));
    opened.add(socket);
    socket.on("close", () => opened.delete(socket));
    // POP3 — байтовый протокол: клиент читает latin1, поэтому и сервер должен
    // писать байты, а не UTF-8 (иначе сравнение строк в тесте ломается).
    const send = (s: string) => socket.write(Buffer.from(s, "latin1"));
    send(opts.noGreeting ? "Server not ready\r\n" : "+OK POP3 ready\r\n");

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        received.push(line);

        if (line.startsWith("USER ")) send("+OK\r\n");
        else if (line.startsWith("PASS ")) send(opts.rejectPass ? "-ERR неверный пароль\r\n" : "+OK\r\n");
        else if (line === "UIDL") {
          send("+OK\r\n");
          for (const u of opts.uidls ?? []) send(u.num + " " + u.uid + "\r\n");
          send(".\r\n");
        } else if (line.startsWith("RETR ")) {
          const num = Number(line.slice(5));
          const body = opts.messages?.[num];
          if (body === undefined) {
            send("-ERR нет такого письма\r\n");
          } else {
            send("+OK " + body.length + " octets\r\n");
            // Тело — байты: latin1-декодирование и обратное кодирование их сохраняют,
            // поэтому UTF-8 внутри письма доходит до клиента без искажений.
            // dot-stuffing по стандарту: строки, начинающиеся с точки, удваиваются.
            for (const l of body.toString("latin1").split("\r\n")) {
              send((l.startsWith(".") ? "." + l : l) + "\r\n");
            }
            send(".\r\n");
          }
        } else if (line === "QUIT") {
          send("+OK bye\r\n");
          socket.end();
        }
      }
    });
  });

  return new Promise<{ port: number; received: string[]; errors: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        errors,
        // Закрываем и оставшиеся соединения: иначе server.close() ждёт их вечно,
        // и тест падает по таймауту вместо проверки поведения.
        close: () =>
          new Promise<void>((r) => {
            for (const s of opened) s.destroy();
            opened.clear();
            server.close(() => r());
          })
      });
    });
  });
}

function clientFor(port: number) {
  return new Pop3Client({
    host: "127.0.0.1",
    port,
    tls: "none",
    username: "test@mail.test",
    password: "secret",
    timeoutMs: 5000
  });
}

/** Прогон сценария с гарантированной уборкой соединения. */
async function withServer(
  opts: FakeOptions,
  run: (ctx: { port: number; received: string[]; client: Pop3Client }) => Promise<void>
): Promise<void> {
  const srv = await startFakeServer(opts);
  const client = clientFor(srv.port);
  try {
    await run({ port: srv.port, received: srv.received, client });
  } finally {
    // Клиент мог остаться подключённым после ожидаемой ошибки.
    await client.quit().catch(() => undefined);
    await srv.close();
  }
}

describe("подключение и вход", () => {
  test("приветствие и успешный вход", async () => {
    await withServer({}, async ({ client, received }) => {
      await client.connect();
      await client.login();
      expect(received).toContain("USER test@mail.test");
      expect(received).toContain("PASS secret");
    });
  });

  test("сервер без приветствия отклоняется", async () => {
    await withServer({ noGreeting: true }, async ({ client }) => {
      await expect(client.connect()).rejects.toThrow(/приветстви/);
    });
  });

  test("неверный пароль даёт понятную ошибку без раскрытия ответа сервера", async () => {
    await withServer({ rejectPass: true }, async ({ client }) => {
      await client.connect();
      await expect(client.login()).rejects.toThrow(/неверный логин\/пароль/);
    });
  });
});

describe("список писем", () => {
  test("UIDL разбирается в номер и идентификатор", async () => {
    await withServer(
      {
        uidls: [
          { num: 1, uid: "uid-one" },
          { num: 2, uid: "uid-two" }
        ]
      },
      async ({ client }) => {
        await client.connect();
        expect(await client.uidl()).toEqual([
          { num: 1, uid: "uid-one" },
          { num: 2, uid: "uid-two" }
        ]);
      }
    );
  });

  test("пустой ящик даёт пустой список", async () => {
    await withServer({ uidls: [] }, async ({ client }) => {
      await client.connect();
      expect(await client.uidl()).toEqual([]);
    });
  });
});

describe("получение письма", () => {
  test("тело не содержит строку статуса «+OK»", async () => {
    const body = Buffer.from(["Subject: Test", "", "body line"].join("\r\n"), "latin1");
    await withServer({ messages: { 1: body } }, async ({ client }) => {
      await client.connect();
      const text = (await client.retrieve(1)).toString("latin1");
      // Регрессия: раньше строка «+OK … octets» могла попасть в тело письма.
      expect(text).not.toContain("+OK");
      expect(text).toContain("Subject: Test");
      expect(text).toContain("body line");
    });
  });

  test("точка-завершитель не попадает в тело", async () => {
    const body = Buffer.from(["Subject: X", "", "end"].join("\r\n"), "latin1");
    await withServer({ messages: { 1: body } }, async ({ client }) => {
      await client.connect();
      const text = (await client.retrieve(1)).toString("latin1");
      // Точка-завершитель — служебная строка, в тело она попадать не должна.
      expect(text.endsWith(".\r\n")).toBe(false);
      expect(text.trim().endsWith("end")).toBe(true);
    });
  });

  test("экранированная точка в теле разэкранируется (dot-stuffing)", async () => {
    // В теле — строка, начинающаяся с ОДНОЙ точки; сервер обязан её удвоить,
    // а клиент — вернуть обратно.
    const body = Buffer.from(["Subject: X", "", ".hidden dot", "plain line"].join("\r\n"), "latin1");
    await withServer({ messages: { 1: body } }, async ({ client }) => {
      await client.connect();
      const text = (await client.retrieve(1)).toString("latin1");
      expect(text).toContain(".hidden dot");
      expect(text).not.toContain("..hidden dot");
    });
  });

  test("байты тела переносятся без изменений (POP3 — байтовый протокол)", async () => {
    // Кодировку разбирает mailparser по заголовкам, клиент обязан отдать байты как есть.
    const body = Buffer.from(
      ["Subject: Enc", "Content-Type: text/plain; charset=utf-8", "", "Привет"].join("\r\n"),
      "utf8"
    );
    await withServer({ messages: { 1: body } }, async ({ client }) => {
      await client.connect();
      const got = await client.retrieve(1);
      expect(got.toString("latin1")).toBe(Buffer.concat([body, Buffer.from("\r\n", "latin1")]).toString("latin1"));
    });
  });

  test("несуществующее письмо даёт ошибку", async () => {
    await withServer({ messages: {} }, async ({ client }) => {
      await client.connect();
      await expect(client.retrieve(99)).rejects.toThrow(/RETR/);
    });
  });
});

describe("завершение соединения", () => {
  test("quit закрывает соединение штатно, а не обрывом", async () => {
    const srv = await startFakeServer({});
    const client = clientFor(srv.port);
    // ⚠️ Признак ECONNRESET берём у поддельного сервера: локальная переменная, которую
    // никто не менял, делала проверку тавтологией — регрессия «обрыв в quit()» не ловилась.
    try {
      await client.connect();
      await client.quit();
      // Клиент шлёт QUIT и закрывается через FIN; серверная сторона не должна
      // получить ECONNRESET — иначе штатное завершение выглядит как сбой.
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      await srv.close();
    }
    // Обрыва быть не должно: штатное завершение — это FIN, а не ECONNRESET.
    expect(srv.errors).not.toContain("ECONNRESET");
    expect(srv.received).toContain("QUIT");
  });
});
