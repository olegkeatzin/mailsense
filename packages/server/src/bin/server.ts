import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist =
  process.env.MAILSENSE_WEB_DIST ?? path.resolve(__dirname, "../../../web/dist");

const server = await startServer({ webDist });
// eslint-disable-next-line no-console
console.log("MailSense server: " + server.url);
