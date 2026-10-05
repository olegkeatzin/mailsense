
/**
 * Сквозная проверка POP3 на стенде: один ящик, три режима подключения (implicit TLS,
 * STARTTLS, без шифрования).
 *
 * Раньше сценарий не проверял ничего: провал печатался в консоль, но кода возврата не было
 * вовсе, а упавшее соединение не закрывалось — процесс висел, пока сокет не отвалится по
 * 30-секундному таймауту, и только потом завершался с кодом 0. Теперь провал виден и в
 * выводе, и в коде возврата.
 *
 * Пароль ящика — только из окружения (см. AGENTS.md и test mail/README.md):
 *   $env:STAND_PASS  — общий пароль стенда (как в send-test-scenario.mjs)
 *   $env:STAND_HOST  — по умолчанию 127.0.0.1
 *   $env:STAND_USER  — по умолчанию test@mail.test
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/core/dist/index.js");

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("  OK    " + name + (detail ? " — " + detail : ""));
  } else {
    failed++;
    console.log("  ПРОВАЛ " + name + (detail ? " — " + detail : ""));
  }
}

async function main() {
  console.log("=== POP3: сквозной сценарий ===");

  // Пароль стенда — только из окружения (см. AGENTS.md).
  const pass = process.env.STAND_PASS;
  if (!pass) {
    check("пароль ящика задан (STAND_PASS)", false, "пароли стенда в репозитории не хранятся — см. test mail/README.md");
    return;
  }

  // Явная проверка сборки: без dist сценарий раньше просто ничего не делал,
  // и это выглядело как «прошло».
  if (!existsSync(DIST)) {
    check("сборка core на месте (packages/core/dist/index.js)", false, "файла нет — соберите core, см. docs/build.md");
    return;
  }
  check("сборка core на месте (packages/core/dist/index.js)", true);

  const { Pop3Client } = await import(pathToFileURL(DIST).href);

  for (const [port, tls] of [[995, "ssl"], [110, "starttls"], [110, "none"]]) {
    const label = "POP3 " + port + "/" + tls;
    const c = new Pop3Client({
      host: process.env.STAND_HOST || "127.0.0.1", port, tls,
      username: process.env.STAND_USER || "test@mail.test", password: pass,
      rejectUnauthorized: false
    });
    try {
      await c.connect();
      await c.login();
      const refs = await c.uidl();
      check(label + ": подключение, вход и список писем", true, "писем " + refs.length);
      if (refs.length > 0) {
        try {
          const msg = await c.retrieve(refs[refs.length - 1].num);
          check(label + ": тело последнего письма читается", msg.length > 0, msg.length + " байт");
          console.log("         письмо (60 байт): " + JSON.stringify(msg.slice(0, 60).toString("latin1")));
        } catch (e) {
          check(label + ": тело последнего письма читается", false, e.message);
        }
      } else {
        console.log("         (ящик пуст — RETR проверять не на чем)");
      }
    } catch (e) {
      check(label + ": подключение, вход и список писем", false, e.message);
    } finally {
      // Закрываем соединение ДАЖЕ после провала: иначе сокет держит event loop и скрипт
      // не завершается, а значит не отдаёт ни кода возврата, ни итога.
      await c.quit().catch(() => undefined);
    }
  }
}

main()
  .catch((e) => {
    console.error("Ошибка сценария:", e);
    failed++;
  })
  .finally(() => {
    console.log("\n=== Итог: " + passed + " успешно, " + failed + " провалено ===");
    process.exitCode = failed ? 1 : 0;
  });
