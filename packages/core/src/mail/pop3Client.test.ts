import net from "node:net";
import tls from "node:tls";
import { Pop3Client } from "./pop3Client.js";

/**
 * Параметры, с которыми клиент зовёт tls.connect. По одному только успешному
 * рукопожатию не видно, передан servername или нет, — а именно от этого
 * зависит, работает ли STARTTLS по IP-адресу.
 */
const tlsConnectOptions: Array<Record<string, unknown>> = [];

// Обёртка над настоящим node:tls: запоминаем аргументы и делегируем дальше,
// поэтому рукопожатия в тестах остаются настоящими.
jest.mock("node:tls", () => {
  const actual = jest.requireActual("node:tls");
  return {
    // Без __esModule: и клиент, и тест импортируют модуль как default.
    ...actual,
    connect: (options: Record<string, unknown>) => {
      tlsConnectOptions.push(options);
      return actual.connect(options);
    }
  };
});

// Одноразовая самоподписанная пара ТОЛЬКО для поддельного STARTTLS-сервера
// в этом файле. В продукте не используется, доверия не даёт (сертификат
// подписан сам собой, клиент подключается с rejectUnauthorized: false).
const TEST_TLS_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAv7ypm4nAwAg+03fC5XIznwTr/qVot8MXAUdFDmoCThAM10qy
i4rEClA7a2FXYYl72jPnq48KCoiA7u/jA98f87n1ZomN8xF/NcoRaxjaGrR+yqJm
hJuBR/Mt1/XaXi5YvHAm6uUvpIAvXY/UqBBul4JPDAIT/7aAp0FhuzSnHJM2uj5m
5hkjYbSj4F49KAX3YPDnKtKHW03D/UEti837J0f7vfTnftxhu3jmM4yOt08U/yyH
pCTeUyAH60Bv8ZWLDsKOzf3LhT97EqWg66gmWUSirI12CRy/rR6ZNdT+c8aTz395
sS9zVDYMAaZ9MhcfzLuwp0GcTtWFdyLTPMKi0QIDAQABAoIBAQCdb9fA3HLF+79C
usLwzj4u48a3+LAsu+eG6DN+63LrEGjK2w4SYKYqZcj0miA6+b4V5KrlBvXSwlVE
XPuGMU82PMqRIH/LR+GxlDOLQgPNC8pUrtcJKfsUzkwlWT2uOdYpHNoH5JqjM5Iw
/Co8ugllJN2tWYN8ZCntrFUId+qEHb0LSg1ySdHtF/xo6YmtwfP58m0aqhOfMGJ3
c4GwVArnXS4GuQKcRAUl5btgLw4XC578an2w/NFM/XL56s5oIsUVL5RxE3hrUNgt
nSWbfKNj/+vv8q+DJYiyJf56nt6HsXTwt9YUeiAohUcS78JSSCGz9jxHBpat+th8
NseiYYxFAoGBAOfKdS3eqGWIMSqc/SRqe92bPEeIFY5rHxfapP1ifUR6D9Iw0HQ3
GDHiX9yKAOkxLIRIGCDJZyBF+aa/kfDangof0VD6O64mmVVnHWM6zMxVDhyHU441
aI+q4n/RRo91u2/yEsdRBPiWOzy2gF1Hp93FGRv/yWeoyN8EwWJY+korAoGBANPD
Qg6qGQqURdFaYDuXIG9HaLtCqlUQrv7CYGTfQtEQHxl1SOc8c2D+xog1mImOSk6S
Fw+ADU4w7hyEfE+gk/LIgqqlNZbIzN0gBnttTaARc2lyHTU2oAqeWCAu5LIHQiAv
0NxjzxmQO3ZT7nk6PoZsgeIZs0+J2J0R7n0FGLTzAoGBAKw+0fclN+RDYa31/VNb
YfKbEh9h7ArqZa+3RdYZo1cIkcszhSRncK5ZN71OPEENzrP6UxvCLsVX2p5kS5I9
EyYY4NYZLdJLUrSZLMh5gIjzR8pBcgEChVIFvc0X+iRPa9tTe0rsVRJZqWmDgT5Q
Klltxyv8V3GVhrfb880eq9gDAoGAATSKSrUTIWlIoHFoPM6WY6u/X9l4SLWomVCX
5dsTcUcrNiThvlcsvO+WR64uaRIDQEE6ml77NGe44zap0nYygV48yCXakTohWFzX
TJqJp5CR3JbGrcfaz1SpYb2ClbTO3ooHIUn8IsQcYocFw3DebDtv3c6Ro7FAJ1yz
w8hkpJsCgYBN2hqOtSYy4a87zi0gGaXJtTtAVVEQ1Z2jbbncTB7gzpn0Bysu0x44
V67LTs8j4oo4nO/u0ZftZjDDi1jl7bLCXh0rV8wxwc0nHNPwHkIS/Y5DB4Un4P8M
3A3USgG35mXNhvhi4Z2nwgROdvEdbQy7OfAZfZJc7lZgTKo7+YDmWg==
-----END RSA PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIICyjCCAbKgAwIBAgIIE2RZRVzKPaMwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UE
AxMJbG9jYWxob3N0MCAXDTI2MTAwNDE1MzU1NloYDzIwNzYxMDA1MTUzNTU2WjAU
MRIwEAYDVQQDEwlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/vKmbicDACD7Td8LlcjOfBOv+pWi3wxcBR0UOagJOEAzXSrKLisQKUDtr
YVdhiXvaM+erjwoKiIDu7+MD3x/zufVmiY3zEX81yhFrGNoatH7KomaEm4FH8y3X
9dpeLli8cCbq5S+kgC9dj9SoEG6Xgk8MAhP/toCnQWG7NKcckza6PmbmGSNhtKPg
Xj0oBfdg8Ocq0odbTcP9QS2LzfsnR/u99Od+3GG7eOYzjI63TxT/LIekJN5TIAfr
QG/xlYsOwo7N/cuFP3sSpaDrqCZZRKKsjXYJHL+tHpk11P5zxpPPf3mxL3NUNgwB
pn0yFx/Mu7CnQZxO1YV3ItM8wqLRAgMBAAGjHjAcMBoGA1UdEQQTMBGCCWxvY2Fs
aG9zdIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAnRLBcrplI3k/lGGbi/KK7g2K
Ni9UQDl2poBRxXb0Fimqyh1cADUurvYZwTbu9JLinoH1eg9HVqqOHDMBsSi+Qtwf
o3vImMJOEVoTNULzA1vz6MRtyzwoCthPYQJqvnCptPJg2p/pscS4iGeCmIX1d1Vm
8EDy2EvF1CBApVHL4B+oRypKeHsYv5MhCf6iV9w2YFyc2IcVyHEKrDxq20LZKhEy
FERs6b1jMt7wlZA9kWlt2YQ5DP2XZVBWDqQAugL9XcM97FaJWgBaQlUgS3l5yt8J
jHwme+EP3tu3QYV+qIYKRhZ7Vh6UNyRcXjWqu6MpCumy61mfkHggZDJY8pqYWg==
-----END CERTIFICATE-----`;

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
  /** Сервер принял соединение и молчит: ни приветствия, ни ответов. */
  silent?: boolean;
  /** Сервер здоровается и пускает по логину/паролю, а дальше молчит. */
  silentAfterLogin?: boolean;
  /** Задержка ответа: живой, но медленный сервер. */
  delayMs?: number;
  /** Умеет STARTTLS: поднимает TLS над тем же сокетом. */
  starttls?: boolean;
}

function startFakeServer(opts: FakeOptions, bindHost?: string) {
  const received: string[] = [];
  // Ошибки сокета со стороны сервера: нужны тесту quit(), иначе проверка тавтологична.
  const errors: string[] = [];
  const opened = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Обрыв на стороне клиента не должен валить тест необработанным исключением.
    socket.on("error", (e) => errors.push((e as NodeJS.ErrnoException).code ?? "unknown"));
    opened.add(socket);
    socket.on("close", () => opened.delete(socket));

    // Текущий сокет: до STLS — открытый, после — TLS-обёртка над ним.
    let current: net.Socket = socket;
    // POP3 — байтовый протокол: клиент читает latin1, поэтому и сервер должен
    // писать байты, а не UTF-8 (иначе сравнение строк в тесте ломается).
    const send = (s: string) => {
      const write = () => current.write(Buffer.from(s, "latin1"));
      if (!opts.delayMs) return void write();
      setTimeout(write, opts.delayMs);
    };
    if (!opts.silent) send(opts.noGreeting ? "Server not ready\r\n" : "+OK POP3 ready\r\n");

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        received.push(line);

        if (line.startsWith("USER ")) send("+OK\r\n");
        else if (line.startsWith("PASS ")) send(opts.rejectPass ? "-ERR неверный пароль\r\n" : "+OK\r\n");
        // Команды принимаются, ответа нет — так выглядит зависший POP3-сервер:
        // соединение живо, readLine ждёт вечно.
        else if (opts.silentAfterLogin) continue;
        else if (line === "STLS" && opts.starttls) {
          // Настоящий STARTTLS: отвечаем в открытом виде и поднимаем TLS над тем
          // же сокетом, как это делает почтовый сервер.
          send("+OK начинаем TLS\r\n");
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT })
          });
          socket.removeListener("data", onData);
          current = secure;
          opened.add(secure);
          secure.on("error", (e) => errors.push((e as NodeJS.ErrnoException).code ?? "unknown"));
          secure.on("close", () => opened.delete(secure));
          secure.on("data", onData);
        } else if (line === "UIDL") {
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
          current.end();
        }
      }
    };
    socket.on("data", onData);
  });

  return new Promise<{ port: number; received: string[]; errors: string[]; close: () => Promise<void> }>((resolve) => {
    const onListening = () => {
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
    };
    // Без bindHost слушаем все интерфейсы: нужно, чтобы «localhost» доходил и
    // по IPv6, и по IPv4 (проверка SNI по имени хоста).
    if (bindHost) server.listen(0, bindHost, onListening);
    else server.listen(0, onListening);
  });
}

function clientFor(port: number, timeoutMs = 5000, mode: "none" | "ssl" | "starttls" = "none", host = "127.0.0.1") {
  return new Pop3Client({
    host,
    port,
    tls: mode,
    username: "test@mail.test",
    password: "secret",
    timeoutMs
  });
}

/** Прогон сценария с гарантированной уборкой соединения. */
async function withServer(
  opts: FakeOptions,
  run: (ctx: { port: number; received: string[]; client: Pop3Client }) => Promise<void>,
  timeoutMs = 5000
): Promise<void> {
  const srv = await startFakeServer(opts);
  const client = clientFor(srv.port, timeoutMs);
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

/**
 * Зависший сервер. Симптом в приложении: скан висит «В процессе» до перезапуска,
 * потому что readLine() ждёт строку, а сокетный таймаут никто не обрабатывает.
 */
describe("зависший сервер (таймаут чтения)", () => {
  /** Ожидание исхода с потолком: тест обязан упасть, а не залипнуть сам. */
  const HUNG = "зависло";
  async function settled<T>(p: Promise<T>, ms = 3000): Promise<T | Error | typeof HUNG> {
    return Promise.race([
      // Ошибку тоже возвращаем значением: иначе ожидание «зависло» не отличить
      // от падения — race отвергается вместе с промисом.
      p.then((v) => v, (e: Error) => e),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))
    ]);
  }

  test("молчащий сервер не оставляет connect() ждать вечно", async () => {
    const srv = await startFakeServer({ silent: true });
    const client = clientFor(srv.port, 150);
    const connecting = client.connect();
    try {
      const outcome = await settled(connecting);
      expect(outcome).not.toBe(HUNG);
      // Ошибка должна объяснять причину, а не выглядеть как обрыв.
      expect((outcome as Error).message).toMatch(/не отвечает|таймаут/);
    } finally {
      await client.quit().catch(() => undefined);
      await srv.close();
    }
  });

  test("сервер, замолчавший посреди сеанса, не вешает команду", async () => {
    const srv = await startFakeServer({ silentAfterLogin: true, uidls: [{ num: 1, uid: "a" }] });
    const client = clientFor(srv.port, 150);
    try {
      await client.connect();
      await client.login(); // логин сервер ещё отвечает

      const outcome = await settled(client.uidl());
      expect(outcome).not.toBe(HUNG);
      expect((outcome as Error).message).toMatch(/не отвечает|таймаут/);

      // Соединение уже мертво: следующая команда обязана упасть сразу,
      // а не ждать ещё один таймаут (иначе аккаунт «залипает»).
      const again = await settled(client.uidl(), 1500);
      expect(again).not.toBe(HUNG);
      // Сообщение, а не instanceof: ошибку порождает поток Node, и через границу
      // песочницы jest она не проходит проверку на локальный класс Error.
      expect((again as Error).message).toMatch(/destroyed|соединени|POP3/i);
    } finally {
      await client.quit().catch(() => undefined);
      await srv.close();
    }
  });

  test("медленный, но живой сервер таймаутом не ломается", async () => {
    // Регрессия: обработчик 'timeout' не должен рвать живое соединение —
    // ответ приходит позже, но в пределах таймаута.
    await withServer(
      { uidls: [{ num: 1, uid: "alive-1" }], delayMs: 120 },
      async ({ client }) => {
        await client.connect();
        await expect(client.uidl()).resolves.toEqual([{ num: 1, uid: "alive-1" }]);
      },
      3000
    );
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

describe("STARTTLS", () => {
  beforeEach(() => {
    tlsConnectOptions.length = 0;
  });

  /** Клиент STARTTLS: сертификат в тесте самоподписанный. */
  function starttlsClient(host: string, port: number) {
    return new Pop3Client({
      host,
      port,
      tls: "starttls",
      username: "test@mail.test",
      password: "secret",
      rejectUnauthorized: false,
      timeoutMs: 5000
    });
  }

  test("STARTTLS к 127.0.0.1 проходит, servername для IP не задаётся", async () => {
    const srv = await startFakeServer({ starttls: true, uidls: [{ num: 1, uid: "tls-1" }] });
    const client = starttlsClient("127.0.0.1", srv.port);
    try {
      await client.connect();
      await client.login();
      expect(await client.uidl()).toEqual([{ num: 1, uid: "tls-1" }]);

      // Раньше сюда уходило servername: "127.0.0.1", Node бросал ERR_INVALID_ARG_VALUE
      // («Setting the TLS ServerName to an IP address is not permitted»), и STARTTLS
      // не работал вообще ни у кого.
      const upgrades = tlsConnectOptions.filter((o) => o.socket !== undefined);
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0].servername).toBeUndefined();
    } finally {
      await client.quit().catch(() => undefined);
      await srv.close();
    }
  });

  test("для имени хоста servername передаётся — иначе не проверить сертификат", async () => {
    // Слушаем все интерфейсы: «localhost» может разрешиться и в ::1, и в 127.0.0.1.
    const srv = await startFakeServer({ starttls: true, uidls: [] }, undefined);
    const client = starttlsClient("localhost", srv.port);
    try {
      await client.connect();
      const upgrades = tlsConnectOptions.filter((o) => o.socket !== undefined);
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0].servername).toBe("localhost");
      await client.quit().catch(() => undefined);
    } finally {
      await srv.close();
    }
  });
});
