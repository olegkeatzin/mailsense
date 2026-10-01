import { Pop3Client } from "../packages/core/dist/index.js";

async function main() {
  // Пароль стенда — только из окружения (см. AGENTS.md).
  const pass = process.env.STAND_PASS;
  if (!pass) {
    console.error("Задайте STAND_PASS — пароль тестового ящика стенда");
    process.exit(1);
  }
  for (const [port, tls] of [[995, "ssl"], [110, "starttls"], [110, "none"]]) {
    try {
      const c = new Pop3Client({
        host: process.env.STAND_HOST || "127.0.0.1", port, tls,
        username: process.env.STAND_USER || "test@mail.test", password: pass,
        rejectUnauthorized: false
      });
      await c.connect();
      await c.login();
      const refs = await c.uidl();
      console.log("POP3 " + port + "/" + tls + ": OK, сообщений: " + refs.length);
      if (refs.length > 0) {
        const msg = await c.retrieve(refs[refs.length - 1].num);
        console.log("  последнее письмо (60 байт): " + JSON.stringify(msg.slice(0, 60).toString("latin1")));
      }
      await c.quit();
    } catch (e) {
      console.log("POP3 " + port + "/" + tls + ": FAIL - " + e.message);
    }
  }
}
main();
