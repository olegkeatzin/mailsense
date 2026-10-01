// Сценарий тестовой переписки на стенде docker-mailserver.
// Отправитель -> гендир (с вложениями) -> резолюция исполнителю + пользователю приложения.
// Запуск: node scripts/send-test-scenario.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// nodemailer лежит в изолированном node_modules пакета core (pnpm) — резолвим оттуда.
const nodemailer = createRequire(path.join(__dirname, "../packages/core/package.json"))("nodemailer");
const LETTERS_DIR = path.resolve(__dirname, "../../test mail/тестовые письма");

const HOST = process.env.STAND_SMTP_HOST || "127.0.0.1";
const PORT = Number(process.env.STAND_SMTP_PORT || "25"); // 25 = plain AUTH (как в стенде)
const SECURE = PORT === 465;

// Пароли стенда берём ТОЛЬКО из окружения — в публичный репозиторий они не попадают.
// Пример: STAND_PARTNER_PASS=... STAND_CLIENT_PASS=... node scripts/send-test-scenario.mjs
function envPass(role) {
  const pass = process.env["STAND_" + role.toUpperCase() + "_PASS"] || process.env.STAND_PASS;
  if (!pass) {
    console.error(
      "Не задан пароль для «" + role + "»: укажите STAND_" + role.toUpperCase() + "_PASS (или общий STAND_PASS)"
    );
    process.exit(1);
  }
  return pass;
}

const USERS = {
  partner: { user: process.env.STAND_PARTNER_USER || "partner@mail.test", pass: envPass("partner"), name: "ООО «Партнёр»" },
  client: { user: process.env.STAND_CLIENT_USER || "client@mail.test", pass: envPass("client"), name: "АО «Клиент»" },
  director: { user: process.env.STAND_DIRECTOR_USER || "ivanov_ii@mail.test", pass: envPass("director"), name: "Иванов И.И. (ген. директор)" },
  executor: { user: process.env.STAND_EXECUTOR_USER || "petrova_ma@mail.test", pass: envPass("executor"), name: "Петрова М.А. (исполнитель)" },
  app: { user: process.env.STAND_APP_USER || "test@mail.test", pass: envPass("app"), name: "Пользователь приложения" }
};

function transport(u) {
  return nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user: u.user, pass: u.pass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000
  });
}

/** Находит PDF по фрагменту имени (кириллица/пробелы). */
function pdf(token) {
  const files = fs.readdirSync(LETTERS_DIR);
  const name = files.find((f) => f.toLowerCase().includes(token.toLowerCase()) && f.toLowerCase().endsWith(".pdf"));
  if (!name) throw new Error("Не найден PDF по токену: " + token + " в " + LETTERS_DIR);
  return { filename: name, path: path.join(LETTERS_DIR, name) };
}

const sent = [];

async function send(fromKey, msg) {
  const from = USERS[fromKey];
  const info = await transport(from).sendMail({
    from: '"' + from.name + '" <' + from.user + ">",
    to: msg.to,
    cc: msg.cc,
    subject: msg.subject,
    text: msg.text,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: (msg.attachments || []).map((a) => ({ filename: a.filename, path: a.path }))
  });
  sent.push({ from: from.user, to: msg.to, subject: msg.subject, messageId: info.messageId });
  console.log("SENT  " + from.user + " -> " + msg.to + "  [" + info.messageId + "]  " + msg.subject);
  return info.messageId;
}

// Получатель-«пользователь приложения» (по умолчанию test@mail.test); можно переопределить APP_USER.
const APP = process.env.APP_USER || USERS.app.user;
const DIR = USERS.director.user;
const NL = String.fromCharCode(10);

const subjA = "Исх. № 7725 от 26.08.2026 — О соблюдении требований";
const subjB = "Вх. № 1575/РТ от 24.07.2026 — от Государственной корпорации Ростех";
const subjC = "Письмо № 3175 от 31.08.2026 — материалы к ВКС";

// 1) Исходные письма с вложениями — на имя гендиректора, пользователь в копии.
const originalA = await send("partner", {
  to: DIR,
  cc: APP,
  subject: subjA,
  text: ["Уважаемый Иван Иванович!", "", "Направляем письмо по списку рассылки о соблюдении требований. Просим рассмотреть и дать поручение исполнителям.", "", "С уважением,", "ООО «Партнёр»"].join(NL),
  attachments: [pdf("Исх_письмо_по_списку")]
});

const originalB = await send("client", {
  to: DIR,
  cc: APP,
  subject: subjB,
  text: ["Уважаемый Иван Иванович!", "", "Во вложении входящее письмо №1575/РТ. Просим организовать исполнение в установленный срок.", "", "АО «Клиент»"].join(NL),
  attachments: [pdf("1575")]
});

await send("partner", {
  to: DIR,
  cc: APP,
  subject: subjC,
  text: ["Уважаемый Иван Иванович!", "", "Направляем материалы к ВКС (исх. № 3175 от 31.08.2026). Просим учесть при подготовке.", "", "ООО «Партнёр»"].join(NL),
  attachments: [pdf("3175 от")]
});

// 2) Резолюции гендиректора исполнителю, пользователь — в копии.
const resA = await send("director", {
  to: USERS.executor.user,
  cc: APP,
  subject: "Re: " + subjA,
  text: ["Петрова М.А.!", "", "ПРИНЯТЬ К ИСПОЛНЕНИЮ. Подготовить ответ в срок до 05.09.2026, доложить о выполнении.", "", "Иванов И.И."].join(NL),
  inReplyTo: originalA,
  references: originalA
});

await send("executor", {
  to: DIR,
  cc: APP,
  subject: "Re: " + subjA,
  text: ["Иван Иванович!", "", "Резолюция принята к исполнению. Ответ будет подготовлен до 05.09.2026.", "", "Петрова М.А."].join(NL),
  inReplyTo: resA,
  references: [originalA, resA].join(" ")
});

const resB = await send("director", {
  to: USERS.executor.user,
  cc: APP,
  subject: "Re: " + subjB,
  text: ["Петрова М.А.!", "", "СРОЧНО. Подготовить проект ответа в ГК Ростех, срок — 03.09.2026.", "", "Иванов И.И."].join(NL),
  inReplyTo: originalB,
  references: originalB
});

await send("executor", {
  to: DIR,
  cc: APP,
  subject: "Re: " + subjB,
  text: ["Иван Иванович!", "", "Проект ответа готов, прикладываю к докладу. Жду согласования.", "", "Петрова М.А."].join(NL),
  inReplyTo: resB,
  references: [originalB, resB].join(" ")
});

console.log(NL + "Итого отправлено: " + sent.length + " писем.");
