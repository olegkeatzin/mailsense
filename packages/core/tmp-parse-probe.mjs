import { simpleParser } from "mailparser";
const p = await simpleParser(Buffer.from("это не письмо"));
console.log(JSON.stringify({
  subject: p.subject ?? null,
  from: p.from ? String(p.from.text) : null,
  date: p.date ? p.date.toISOString() : null,
  messageId: p.messageId ?? null,
  text: (p.text ?? "").slice(0, 40),
  headersSize: p.headers ? p.headers.size : 0
}));
