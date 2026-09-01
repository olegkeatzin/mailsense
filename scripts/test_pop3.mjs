import { Pop3Client } from "../packages/core/dist/index.js";

async function main() {
  for (const [port, tls] of [[995, "ssl"], [110, "starttls"], [110, "none"]]) {
    try {
      const c = new Pop3Client({
        host: "127.0.0.1", port, tls,
        username: "test@mail.test", password: "Test1234!",
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
