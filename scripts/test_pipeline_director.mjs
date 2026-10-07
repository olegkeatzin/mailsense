#!/usr/bin/env node
/**
 * Пароли стенда — ТОЛЬКО из окружения, в репозитории их быть не должно (уже чистили один раз).
 * Нужны:
 *   $env:STAND_ADMIN_PASS, STAND_IVANOV_PASS, STAND_USER2_PASS, STAND_PARTNER_PASS, STAND_PETROVA_PASS
 *   $env:STAND_MAIL_SERVICE_PASS (test@mail.test), STAND_MAIL_DIRECTOR_PASS (user2@mail.test),
 *   $env:STAND_MAIL_EXECUTOR_PASS (petrova_ma@mail.test);
 *   $env:STAND_MAIL_PARTNER_PASS (partner@mail.test) — только для резервного пути отправки.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodemailer = createRequire(path.join(__dirname, "../packages/core/package.json"))("nodemailer");

function standPass(name) {
  const v = process.env[name];
  if (!v) throw new Error("Не задана переменная окружения " + name + " — пароли стенда в репозитории не хранятся");
  return v;
}

/**
 * Сквозной сценарий заказчика: ВНЕШНЕЕ ПИСЬМО → служебный ящик аппарата → письмо директору
 * из приложения → директор отвечает ПИСЬМОМ → аппарат подтверждает разбор → исполнителю.
 *
 * Ключевое отличие от test_roles_e2e.mjs: здесь НАСТОЯЩИЕ письма через SMTP стенда и настоящий
 * скан ящиков IMAP. Никаких подстановок emailId и моков.
 *
 * Отдельно проверяется подмена подписанта: роль signer выдаётся второму сотруднику через
 * админку, он утверждает — в аудите и карточке именно он; сняли роль — approve снова 403.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";
const SMTP_HOST = process.env.STAND_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.STAND_SMTP_PORT ?? "25");

const ACCOUNTS = {
  admin: { login: "test@stand.test", passEnv: "STAND_ADMIN_PASS" },
  secretary: { login: "Иванов_ИИ@stand.test", passEnv: "STAND_IVANOV_PASS" },
  signer: { login: "user2@stand.test", passEnv: "STAND_USER2_PASS" },
  manager: { login: "partner@stand.test", passEnv: "STAND_PARTNER_PASS" },
  executor: { login: "Петрова_МА@stand.test", passEnv: "STAND_PETROVA_PASS" }
};

const MAIL = {
  service: { user: "test@mail.test", passEnv: "STAND_MAIL_SERVICE_PASS" },
  director: { user: "user2@mail.test", passEnv: "STAND_MAIL_DIRECTOR_PASS" },
  executor: { user: "petrova_ma@mail.test", passEnv: "STAND_MAIL_EXECUTOR_PASS" },
  partner: { user: "partner@mail.test", passEnv: "STAND_MAIL_PARTNER_PASS" }
};

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("  OK    " + name);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log("  ПРОВАЛ " + name + (detail ? " — " + detail : ""));
  }
}
function skip(name, why) {
  skipped++;
  console.log("  ПРОПУСК " + name + " — " + why);
}
function expect(name, result, codes) {
  result = result ?? { status: 0, body: {} };
  const ok = codes.includes(result.status);
  const err = result.body && result.body.error ? " (" + result.body.error + ")" : "";
  check(name, ok, ok ? "" : "получен " + result.status + err + ", ожидался " + codes.join("/"));
  return ok;
}

function session(account) {
  const state = { cookie: "" };
  async function req(p, options = {}) {
    const res = await fetch(BASE + p, {
      ...options,
      headers: { "Content-Type": "application/json", ...(state.cookie ? { Cookie: state.cookie } : {}), ...(options.headers ?? {}) }
    });
    const sc = res.headers.get("set-cookie");
    if (sc) state.cookie = sc.split(";")[0];
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }
  return {
    name: account.login,
    get: (p) => req(p),
    post: (p, b = {}) => req(p, { method: "POST", body: JSON.stringify(b) }),
    put: (p, b = {}) => req(p, { method: "PUT", body: JSON.stringify(b) }),
    patch: (p, b = {}) => req(p, { method: "PATCH", body: JSON.stringify(b) }),
    async login() {
      return req("/api/auth/login", { method: "POST", body: JSON.stringify({ login: account.login, password: standPass(account.passEnv) }) });
    },
    async perms() { const r = await req("/api/auth/me"); return r.body?.user?.permissions ?? []; },
    async roles() { const r = await req("/api/auth/me"); return r.body?.user?.roles ?? []; }
  };
}

function isoDay(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function sendMail(from, msg) {
  const tr = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: from.user, pass: standPass(from.passEnv) },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000, greetingTimeout: 15000
  });
  try {
    const info = await tr.sendMail({
      from: msg.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text,
      inReplyTo: msg.inReplyTo, references: msg.references
    });
    console.log("       SMTP: " + from.user + " -> " + msg.to + " [" + info.messageId + "] " + msg.subject);
    return info;
  } finally {
    tr.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Скан ящика: письмо должно реально приехать по IMAP, иначе его не увидит и приложение. */
async function fetchAccount(sess, accountId, label) {
  const r = await sess.post("/api/accounts/" + accountId + "/fetch", {});
  check("скан ящика " + label + " выполнен", r.status === 200, "статус " + r.status + " " + JSON.stringify(r.body).slice(0, 120));
  return r;
}

async function inbox(sess, accountId) {
  const r = await sess.get("/api/emails?accountId=" + accountId + "&folder=INBOX");
  return { status: r.status, items: Array.isArray(r.body) ? r.body : [] };
}

/**
 * Ждёт письмо в ящике: SMTP отдаёт сообщение postfix'у мгновенно, а доставка в mailbox
 * и его появление по IMAP — на мгновение позже. Без повторов тест ловит гонку и врёт.
 */
async function waitForInbox(sess, accountId, predicate, attempts = 6, delayMs = 2500) {
  for (let i = 1; i <= attempts; i++) {
    await sess.post("/api/accounts/" + accountId + "/fetch", {});
    const list = await inbox(sess, accountId);
    const found = list.items.find(predicate);
    if (found) return { found, attempts: i, items: list.items };
    if (i < attempts) await sleep(delayMs);
  }
  const last = await inbox(sess, accountId);
  return { found: null, attempts, items: last.items };
}

/** То же для «Входящих на регистрацию»: письмо должно доехать и попасть в очередь аппарата. */
async function waitForIncoming(sess, accountId, predicate, attempts = 6, delayMs = 2500) {
  let items = [];
  for (let i = 1; i <= attempts; i++) {
    await sess.post("/api/accounts/" + accountId + "/fetch", {});
    const r = await sess.get("/api/docflow/journal/incoming?limit=300");
    items = Array.isArray(r.body?.items) ? r.body.items : [];
    const found = items.find(predicate);
    if (found) return { found, attempts: i, items };
    if (i < attempts) await sleep(delayMs);
  }
  return { found: null, attempts, items };
}

async function runCleanup(label, tasks) {
  for (const fn of tasks.slice().reverse()) {
    try { await fn(); } catch (e) { console.error("  (" + label + " откат: " + (e && e.message ? e.message : e) + ")"); }
  }
}

async function main() {
  console.log("=== Пайплайн заказчика: аппарат → директор (ответ письмом) → исполнитель ===");
  const stamp = Date.now();
  const cleanup = [];
  let roleRestore = null;

  const admin = session(ACCOUNTS.admin);
  const secretary = session(ACCOUNTS.secretary);
  const signer = session(ACCOUNTS.signer);
  const manager = session(ACCOUNTS.manager);
  const executor = session(ACCOUNTS.executor);

  check("администратор вошёл", (await admin.login()).status === 200);
  for (const pair of [["аппарат", secretary], ["подписант", signer], ["руководитель", manager], ["исполнитель", executor]]) {
    const r = await pair[1].login();
    check(pair[0] + " вошёл", r.status === 200, "статус " + r.status);
  }

  // ---------- 0. Ящики и участники ----------
  console.log("\n--- ящики и участники ---");
  const accountsRes = await admin.get("/api/accounts");
  const accounts = Array.isArray(accountsRes.body) ? accountsRes.body : [];
  const byUser = (u) => accounts.find((a) => String(a.username ?? "").toLowerCase() === u.toLowerCase());
  const accService = byUser(MAIL.service.user);
  const accDirector = byUser(MAIL.director.user);
  const accExecutor = byUser(MAIL.executor.user);
  check("служебный ящик найден в аккаунтах", !!accService, MAIL.service.user);
  check("ящик директора найден", !!accDirector, MAIL.director.user);
  if (!accService || !accDirector) {
    console.log("Дальше идти некуда: не найдены почтовые ящики.");
    process.exit(1);
  }

  const usersRes = await admin.get("/api/users?includeInactive=1");
  const allUsers = Array.isArray(usersRes.body) ? usersRes.body : [];
  const byLogin = (login) => {
    const uid = login.split("@")[0].toLowerCase();
    return allUsers.find((u) => (u.ldapUid ?? "").toLowerCase() === uid || (u.email ?? "").toLowerCase() === login.toLowerCase());
  };
  const uSigner = byLogin(ACCOUNTS.signer.login);
  const uExecutor = byLogin(ACCOUNTS.executor.login);
  const uPartner = byLogin(ACCOUNTS.manager.login);
  check("директор найден в справочнике", !!uSigner, ACCOUNTS.signer.login);
  check("исполнитель найден в справочнике", !!uExecutor, ACCOUNTS.executor.login);
  check("есть третий сотрудник для подмены подписанта", !!uPartner, ACCOUNTS.manager.login);
  if (!uSigner || !uExecutor || !uPartner) process.exit(1);

  // ---------- 1. Внешнее письмо приходит на служебный ящик ----------
  console.log("\n--- внешнее письмо на служебный ящик ---");
  const subject = "Пайплайн QA " + stamp + ": письмо внешнего контрагента";
  let externalMode = "";
  try {
    await sendMail(MAIL.service, {
      from: '"ООО «Калужский завод»" <manufactory@kaluga.net>',
      to: MAIL.service.user,
      subject,
      text: "Направляем обращение по договору поставки. Просим рассмотреть и дать поручение исполнителю."
    });
    externalMode = "внешний From manufactory@kaluga.net (авторизация служебного ящика)";
  } catch (e) {
    console.log("       внешний From не принят (" + (e.message ?? e).split("\n")[0] + "), резервный путь");
    await sendMail(MAIL.partner, {
      from: '"ООО «Калужский завод» (внешний стенд)" <partner@mail.test>',
      to: MAIL.service.user,
      subject,
      text: "Направляем обращение по договору поставки. Просим рассмотреть и дать поручение исполнителю."
    });
    externalMode = "резерв: partner@mail.test";
  }
  console.log("       режим отправки внешнего письма: " + externalMode);
  const origWait = await waitForIncoming(secretary, accService.id, (i) => String(i.subject ?? "").includes(String(stamp)));
  const original = origWait.found;
  check("внешнее письмо видно во «Входящих на регистрацию»", !!original,
    "писем в очереди: " + origWait.items.length + ", попыток: " + origWait.attempts);
  if (!original) {
    console.log("Дальше идти некуда: письмо не доехало до приложения.");
    process.exit(1);
  }
  const reg = await secretary.post("/api/docflow/journal", {
    emailId: original.emailId,
    summary: "Пайплайн QA " + stamp + ": обращение контрагента",
    sender: "ООО «Калужский завод»"
  });
  expect("аппарат регистрирует письмо в журнале", reg, [201]);
  const documentId = reg.body?.id;
  check("документ получил номер", !!reg.body?.regNumber, String(reg.body?.regNumber));
  if (!documentId) process.exit(1);

  // ---------- 3. Письмо директору — СО СЛУЖЕБНОГО ящика ----------
  console.log("\n--- аппарат направляет письмо директору ---");
  const fwd = await secretary.post("/api/docflow/resolutions/forward", { documentId, toUserId: uSigner.id });
  expect("письмо направлено директору", fwd, [201]);
  const resId = fwd.body?.id;
  check("адрес директора — в каталоге", fwd.body?.sentTo === MAIL.director.user, String(fwd.body?.sentTo));
  check("состояние — на утверждении", fwd.body?.status === "pending_approval", String(fwd.body?.status));
  check("сохранён id отправленного письма", !!fwd.body?.sentEmailId, String(fwd.body?.sentEmailId));
  check("сохранён id письма-запроса", !!fwd.body?.requestEmailId, String(fwd.body?.requestEmailId));

  const sentView = fwd.body?.sentEmailId ? await admin.get("/api/emails/" + fwd.body.sentEmailId) : { body: {} };
  check("письмо директору отправлено СО СЛУЖЕБНОГО ящика, а не с ящика директора",
    sentView.body?.from?.address === MAIL.service.user,
    "From = " + String(sentView.body?.from?.address));
  const sentTo = (sentView.body?.to ?? []).map((t) => t.address);
  check("получатель письма — ящик директора", sentTo.includes(MAIL.director.user), JSON.stringify(sentTo));
  check("в письме есть Message-ID (по нему найдётся ответ)", !!sentView.body?.messageId, String(sentView.body?.messageId));
  if (!resId) {
    console.log("Дальше идти некуда: резолюция не создана.");
    process.exit(1);
  }

  // ---------- 4. Письмо реально доехало до директора ----------
  console.log("\n--- доставка директору (IMAP) ---");
  const dirWait = await waitForInbox(admin, accDirector.id, (e) => String(e.subject ?? "").includes(String(stamp)));
  const delivered = dirWait.found;
  check("письмо от аппарата реально доставлено в ящик директора", !!delivered,
    "писем в ящике: " + dirWait.items.length + ", попыток: " + dirWait.attempts);
  if (!delivered) {
    console.log("Дальше идти некуда: директор письма не получил.");
    process.exit(1);
  }
  check("доставленное письмо — от служебного ящика", delivered.from?.address === MAIL.service.user, String(delivered.from?.address));
  const threadMessageId = delivered.messageId;
  check("у доставленного письма есть Message-ID", !!threadMessageId, String(threadMessageId));

  // ---------- 5. Директор отвечает письмом ----------
  console.log("\n--- директор отвечает письмом ---");
  const replyText = "Петрова М.А.! Подготовить ответ контрагенту по договору поставки в срок до " + isoDay(5) + ". Доложить об исполнении. User Two";
  const replySubject = "Re: " + subject;
  await sendMail(MAIL.director, {
    from: '"User Two Mail Test" <' + MAIL.director.user + ">",
    to: MAIL.service.user,
    cc: MAIL.executor.user,
    subject: replySubject,
    text: replyText,
    inReplyTo: threadMessageId,
    references: threadMessageId
  });
  const replyWait = await waitForIncoming(secretary, accService.id,
    (i) => String(i.subject ?? "").includes(String(stamp)) && String(i.from?.address ?? "") === MAIL.director.user);
  let replyMail = replyWait.found;
  if (!replyMail) {
    const fallbackWait = await waitForIncoming(secretary, accService.id,
      (i) => String(i.subject ?? "").includes(String(stamp)) && String(i.subject ?? "").startsWith("Re:"));
    replyMail = fallbackWait.found;
  }
  check("ответ директора доехал до служебного ящика и виден аппарату", !!replyMail,
    "писем в очереди: " + replyWait.items.length + ", попыток: " + replyWait.attempts);
  if (!replyMail) {
    console.log("Дальше идти некуда: ответ директора не доехал.");
    process.exit(1);
  }

  // ---------- 6. Приложение сопоставляет ответ с поручением ----------
  const ctx = await secretary.get("/api/docflow/emails/" + replyMail.emailId + "/reply-context");
  expect("подсказка «не отвечает ли письмо на поручение» отвечает", ctx, [200]);
  const candidates = Array.isArray(ctx.body?.items) ? ctx.body.items : (Array.isArray(ctx.body) ? ctx.body : (ctx.body ? [ctx.body] : []));
  const candidate = candidates.find((c) => c.resolutionId === resId) ?? candidates[0];
  check("ответ сопоставлен с нашим поручением по треду", !!candidate && candidate.resolutionId === resId,
    JSON.stringify(candidates).slice(0, 160));
  check("приложение ждёт именно утверждения", !candidate || candidate.expects === "approval", candidate ? String(candidate.expects) : "нет кандидата");

  // ---------- 7. Аппарат подтверждает разбор ----------
  console.log("\n--- аппарат подтверждает разбор ---");
  const deadline = isoDay(5);
  const confirmed = await secretary.post("/api/docflow/resolutions/" + resId + "/mark-approval", {
    emailId: replyMail.emailId,
    text: replyText,
    assignees: [{ userId: uExecutor.id, kind: "responsible" }],
    deadline
  });
  expect("аппарат подтверждает разбор ответа", confirmed, [200]);
  check("состояние — утверждено", confirmed.body?.status === "approved", String(confirmed.body?.status));
  check("способ утверждения — письмо", confirmed.body?.approvalMethod === "email", String(confirmed.body?.approvalMethod));
  check("утвердил именно директор (отправитель письма)", confirmed.body?.approvedBy === uSigner.id,
    "approvedBy = " + String(confirmed.body?.approvedBy) + ", директор = " + uSigner.id);
  check("текст резолюции взят из письма", String(confirmed.body?.text ?? "").includes("Петрова"), String(confirmed.body?.text ?? "").slice(0, 80));
  check("подтвердил аппарат, а не директор", confirmed.body?.confirmedBy !== confirmed.body?.approvedBy);
  // Маршрут mark-approval возвращает запись резолюции (без исполнителей) — состав смотрим в карточке.
  const cardAfterApprove = await secretary.get("/api/docflow/resolutions/" + resId);
  check("исполнитель записан ответственным",
    (cardAfterApprove.body?.assignees ?? []).some((a) => a.userId === uExecutor.id && a.kind === "responsible"),
    JSON.stringify(cardAfterApprove.body?.assignees ?? []));

  // ---------- 8. Отправка исполнителю ----------
  console.log("\n--- аппарат отправляет исполнителю ---");
  const dispatched = await secretary.post("/api/docflow/resolutions/" + resId + "/dispatch", {});
  expect("поручение ушло исполнителю", dispatched, [200]);
  check("состояние — отправлено", dispatched.body?.status === "sent", String(dispatched.body?.status));

  const tasks = await executor.get("/api/docflow/resolutions/my-tasks");
  const task = (Array.isArray(tasks.body) ? tasks.body : []).find((t) => t.resolutionId === resId);
  check("исполнитель видит задачу", !!task);
  if (task) {
    check("в задаче срок из карточки", task.deadline === deadline, String(task.deadline));
    check("в задаче текст директора", String(task.text ?? "").includes("Петрова"), String(task.text ?? "").slice(0, 60));
  }

  // ---------- 9. Отчёт и закрытие ----------
  console.log("\n--- отчёт исполнителя ---");
  const report = await executor.post("/api/docflow/resolutions/" + resId + "/report", { text: "Ответ контрагенту подготовлен и направлен. Пайплайн QA " + stamp });
  expect("исполнитель отчитался", report, [200]);
  check("поручение закрыто отчётом ответственного", report.body?.status === "done", String(report.body?.status));

  // ---------- 10. Уведомления участникам ----------
  console.log("\n--- уведомления участникам ---");
  const notifOf = async (sess) => ((await sess.get("/api/docflow/notifications?limit=200")).body?.items ?? []);
  const execNotifs = await notifOf(executor);
  check("исполнителю пришло уведомление о назначении", execNotifs.some((n) => n.kind === "resolution.assigned" && n.entityId === resId));
  check("исполнителю пришло уведомление о закрытии", execNotifs.some((n) => n.kind === "resolution.closed" && n.entityId === resId));
  const secNotifs = await notifOf(secretary);
  check("аппарату пришло уведомление об утверждении", secNotifs.some((n) => n.kind === "resolution.approved" && n.entityId === resId));
  check("аппарату пришло уведомление об отчёте", secNotifs.some((n) => n.kind === "resolution.reported" && n.entityId === resId));
  const dirNotifs = await notifOf(signer);
  check("директору пришло уведомление об отчёте", dirNotifs.some((n) => n.kind === "resolution.reported" && n.entityId === resId));

  // ---------- 11. Подмена подписанта ----------
  console.log("\n--- подмена подписанта ---");
  // ⚠️ Партнёр-руководитель УЖЕ имеет resolution.approve (роль manager), поэтому «сняли signer →
  // approve закрыт» на нём не проверить: право остаётся от manager. Берём сотрудника БЕЗ права
  // подписи (исполнителя): выдали signer → он утверждает; сняли → approve снова 403.
  const savedRoles = Array.isArray(uExecutor.roles) ? uExecutor.roles : [];
  check("у сотрудника без права подписи есть роль до подмены", savedRoles.length > 0, savedRoles.join(","));
  roleRestore = async () => { await admin.put("/api/users/" + uExecutor.id + "/roles", { roleIds: savedRoles }); };
  check("до подмены права approve у него нет", !(await executor.perms()).includes("resolution.approve"));

  const grant = await admin.put("/api/users/" + uExecutor.id + "/roles", { roleIds: [...savedRoles, "signer"] });
  expect("администратор выдал роль signer второму сотруднику", grant, [200]);
  const subSigner = session(ACCOUNTS.executor);
  await subSigner.login();
  check("у нового подписанта есть право approve", (await subSigner.perms()).includes("resolution.approve"));

  const reg2 = await secretary.post("/api/docflow/journal", { summary: "Подмена подписанта QA " + stamp, sender: "QA" });
  const doc2 = reg2.body?.id;
  expect("документ для проверки подмены создан", reg2, [201]);
  const res2 = await secretary.post("/api/docflow/resolutions", {
    documentId: doc2, text: "Проверка подмены подписанта " + stamp, sourceKind: "manual", priority: "normal",
    deadline: isoDay(4), assignees: [{ userId: uExecutor.id, kind: "responsible" }]
  });
  expect("резолюция для подмены создана", res2, [201]);
  const res2Id = res2.body?.id;
  await secretary.post("/api/docflow/resolutions/" + res2Id + "/request-approval", {});
  const subApprove = await subSigner.post("/api/docflow/resolutions/" + res2Id + "/approve", {});
  expect("новый подписант утверждает", subApprove, [200]);
  check("в записи утвердил именно он", subApprove.body?.approvedBy === uExecutor.id,
    "approvedBy = " + String(subApprove.body?.approvedBy));
  const audit2 = await admin.get("/api/audit?entityType=resolution&entityId=" + res2Id + "&limit=50");
  const approveEntry = (audit2.body?.entries ?? []).find((a) => a.action === "resolution.approve");
  check("в аудите утверждение записано на нового подписанта", !!approveEntry && approveEntry.userId === uExecutor.id,
    approveEntry ? String(approveEntry.userId) + " (" + approveEntry.userName + ")" : "записи нет");
  const card2 = await admin.get("/api/docflow/resolutions/" + res2Id);
  check("в карточке видно, кто утвердил", card2.body?.approvedBy === uExecutor.id,
    String(card2.body?.approvedByName ?? card2.body?.approvedBy));

  // сняли роль — approve снова закрыт (проверяем на НОВОЙ резолюции: старая уже утверждена,
  // и отказ по праву обязан идти раньше отказа по состоянию)
  const revoke = await admin.put("/api/users/" + uExecutor.id + "/roles", { roleIds: savedRoles });
  expect("роль signer снята", revoke, [200]);
  const noSign = session(ACCOUNTS.executor);
  await noSign.login();
  check("после снятия роли права approve нет", !(await noSign.perms()).includes("resolution.approve"));
  const res3 = await secretary.post("/api/docflow/resolutions", {
    documentId: doc2, text: "Отказ по праву " + stamp, sourceKind: "manual", priority: "normal",
    deadline: isoDay(4), assignees: [{ userId: uExecutor.id, kind: "responsible" }]
  });
  const res3Id = res3.body?.id;
  await secretary.post("/api/docflow/resolutions/" + res3Id + "/request-approval", {});
  const denied = await noSign.post("/api/docflow/resolutions/" + res3Id + "/approve", {});
  expect("после снятия роли approve закрыт (403)", denied, [403]);
  await roleRestore();
  roleRestore = null;
  const restoredExec = session(ACCOUNTS.executor);
  await restoredExec.login();
  const restoredPerms = await restoredExec.perms();
  check("роль сотрудника восстановлена (исполнитель снова без права подписи)",
    restoredPerms.includes("task.report") && !restoredPerms.includes("resolution.approve"),
    restoredPerms.join(","));
  // Почему подмену проверяем на исполнителе, а не на руководителе из постановки: у роли manager
  // уже есть resolution.approve, поэтому «сняли signer → 403» на нём недостижим.
  check("у роли manager уже есть resolution.approve (подмена signer на руководителя запрет не докажет)",
    (await manager.perms()).includes("resolution.approve"));

  await runCleanup("итог", cleanup);
  console.log("\n=== Итог: " + passed + " проверок, " + failed + " провалов" + (skipped ? ", " + skipped + " пропущено" : "") + " ===");
  if (failures.length) {
    console.log("\nПровалы:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Ошибка сценария:", e);
  process.exit(1);
});
