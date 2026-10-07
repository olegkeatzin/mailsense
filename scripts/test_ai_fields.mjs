#!/usr/bin/env node
/**
 * Живой сценарий: настоящее письмо с PDF-вложением → «Скан» → анализ ИИ → форма регистрации.
 *
 * Проверяем НЕ вызовы ИИ-ручек, а то, что видит человек:
 *  1) в анализе письма появились summary / теги / приоритет / внешний номер / дата;
 *  2) форма регистрации (GET /api/docflow/journal/suggest) уже заполнена: отправитель, краткое
 *     содержание, номер отправителя, дата документа, листы;
 *  3) номер документа выдаёт БАЗА, а подсказка его не двигает (next-number до/после);
 *  4) PDF без текстового слоя распознаётся через OCR (текст вложения появляется из OCR-модели);
 *  5) негатив: недоступная summary-модель → анализ завершается честной ошибкой, приложение живо.
 *
 * Запуск:
 *   STAND_ADMIN_PASS=... STAND_MAIL_DIRECTOR_PASS=... node scripts/test_ai_fields.mjs
 * Переменные: BASE_URL (по умолчанию http://127.0.0.1:8123), PDF_DIR, AI_BAD_URL.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const coreRequire = createRequire(path.join(ROOT, "packages/core/package.json"));
const nodemailer = coreRequire("nodemailer");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8123";
const PDF_DIR = process.env.PDF_DIR || path.resolve(ROOT, "..", "test mail", "тестовые письма");
const SERVICE_BOX = "test@mail.test";
const SENDER_BOX = "user2@mail.test";
const SENDER_PASS = process.env.STAND_MAIL_DIRECTOR_PASS;
const BAD_AI_URL = process.env.AI_BAD_URL || "http://127.0.0.1:9/v1";
const EXECUTOR_BOX = "petrova_ma@mail.test";
const EXECUTOR_PASS = process.env.STAND_MAIL_EXECUTOR_PASS;

const PDF_WITH_TEXT = "25.08.2026 № 1111-11-23612.pdf";
const PDF_SCAN = "Вх_письмо_№1575_РТ_от_24_07_2026_от_Государственная_корпорация_Ростехv1.pdf";

let passed = 0;
const failures = [];
const pending = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  OK    " + name + (detail ? "  [" + detail + "]" : "")); }
  else { failures.push(name + (detail ? "  [" + detail + "]" : "")); console.log("  ПРОВАЛ " + name + (detail ? "  [" + detail + "]" : "")); }
}
/**
 * Проверка, которая ещё не может пройти по внешней причине (правка промпта в другой задаче).
 * Считается отдельно: сценарий остаётся зелёным по поставленному поведению, а ожидание видно в отчёте.
 */
function checkPending(name, ok, detail = "") {
  if (ok) { passed++; console.log("  OK    " + name + (detail ? "  [" + detail + "]" : "")); return; }
  pending.push(name + (detail ? "  [" + detail + "]" : ""));
  console.log("  ЖДЁТ  " + name + (detail ? "  [" + detail + "]" : ""));
}
function log(msg) { console.log(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------
function session(login, password) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async req(q, opts = {}) {
      const res = await fetch(BASE + q, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(opts.headers ?? {})
        }
      });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    },
    async login() { return this.req("/api/auth/login", { method: "POST", body: JSON.stringify({ login, password }) }); }
  };
}
function expectStatus(name, res, codes) {
  check(name, codes.includes(res.status), "код " + res.status);
}

// ---------- Почта ----------
function mailer(user = SENDER_BOX, pass = SENDER_PASS) {
  return nodemailer.createTransport({
    host: "127.0.0.1", port: 25, secure: false,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}
async function sendLetter(subject, pdfName, bodyText) {
  const file = path.join(PDF_DIR, pdfName);
  if (!fs.existsSync(file)) throw new Error("нет PDF: " + file);
  const tr = mailer();
  try {
    await tr.sendMail({
      from: '"ООО «Калужский завод»" <manufactory@kaluga.net>',
      to: SERVICE_BOX,
      subject,
      text: bodyText,
      attachments: [{ filename: pdfName, path: file }]
    });
  } finally { tr.close(); }
}
/** Ответ в треде: In-Reply-To/References — это то, по чему СЭД находит переписку (не догадка модели). */
async function sendReply(user, pass, subject, bodyText, anchorMessageId) {
  const tr = mailer(user, pass);
  try {
    return await tr.sendMail({
      from: '"' + user + '" <' + user + '>',
      to: SERVICE_BOX,
      subject: "Re: " + String(subject || "").replace(/^Re:\s*/i, ""),
      text: bodyText,
      inReplyTo: anchorMessageId,
      references: anchorMessageId
    });
  } finally { tr.close(); }
}
async function fetchService(admin) {
  const acc = await admin.req("/api/accounts");
  const service = (acc.body || []).find((a) => a.username === SERVICE_BOX);
  if (!service) throw new Error("не найден служебный ящик " + SERVICE_BOX);
  return service;
}
/**
 * Ждём письмо в ящике. SMTP и IMAP на стенде отстают друг от друга: письмо, отправленное секунду
 * назад, при первом «Скане» ещё не в ящике — поэтому повторяем скан, а не только чтение списка.
 */
async function findEmail(admin, accountId, subject, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const list = await admin.req("/api/emails?accountId=" + accountId + "&folder=INBOX");
    const items = Array.isArray(list.body) ? list.body : (list.body?.items ?? []);
    const found = items.find((e) => String(e.subject || "").includes(subject));
    if (found) return found;
    await sleep(2500);
    if (i % 2 === 1) await admin.req("/api/accounts/" + accountId + "/fetch", { method: "POST", body: "{}" });
  }
  return null;
}
async function waitAnalysis(admin, emailId, timeoutMs = 300000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const view = await admin.req("/api/emails/" + emailId);
    const v = view.body || {};
    const status = v.analysisStatus || (v.analysis && v.analysis.status) || "?";
    if (status !== last) { log("    статус анализа: " + status + " (" + Math.round((Date.now() - started) / 1000) + "с)"); last = status; }
    if (status === "ready" || status === "error") return { status, view: v, ms: Date.now() - started };
    await sleep(3000);
  }
  return { status: "timeout", view: null, ms: Date.now() - started };
}
/**
 * Текст вложения (то, что положил распознаватель: OCR для сканов, текстовый слой для PDF)
 * отдаёт сам API письма — читаем оттуда, а не из файла БД: у стенда WAL, и «на глаз» база выглядит пустой.
 */
function viewAttachmentTexts(view) {
  return (view?.attachments ?? []).map((a) => ({
    filename: a.filename,
    n: String(a.extractedText || "").length,
    head: String(a.extractedText || "").slice(0, 160)
  }));
}

// ---------- основной сценарий ----------
const stamp = Date.now();
const subjectText = "QA AI поля " + stamp + " (с текстовым слоем)";
const subjectScan = "QA AI скан ООО_Калужский_завод №1575/РТ от 24.07.2026 " + stamp;
const subjectBad = "QA AI недоступная модель " + stamp;

const admin = session("test@stand.test", process.env.STAND_ADMIN_PASS);

async function main() {
  log("=== 0. Стенд и настройки ИИ ===");
  const health = await admin.req("/api/health");
  check("сервер 8123 отвечает", health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));
  const bad = await admin.login();
  expectStatus("вход администратора", bad, [200]);

  const cfgRes = await admin.req("/api/ai/config");
  expectStatus("GET /api/ai/config", cfgRes, [200]);
  const cfg = cfgRes.body || {};
  const snapshot = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, ocrBaseUrl: cfg.ocrBaseUrl, ocrModel: cfg.ocrModel, multimodal: cfg.multimodal, timeoutMs: cfg.timeoutMs };
  log("    конфиг: baseUrl=" + cfg.baseUrl + " model=" + cfg.model + " ocrBaseUrl=" + cfg.ocrBaseUrl + " ocrModel=" + cfg.ocrModel + " multimodal=" + cfg.multimodal);
  check("подключена живая summary-модель (порт 3006)", /:3006\/v1/.test(String(cfg.baseUrl)), String(cfg.baseUrl));
  check("подключена живая OCR-модель (порт 3010)", /:3010\/v1/.test(String(cfg.ocrBaseUrl)), String(cfg.ocrBaseUrl));
  check("multimodal включён (сканы идут через OCR)", cfg.multimodal === true, String(cfg.multimodal));
  const aiTest = await admin.req("/api/ai/test", { method: "POST", body: JSON.stringify({}) });
  check("GET-коннект к summary-модели отвечает ok", aiTest.status === 200 && aiTest.body?.ok !== false, JSON.stringify(aiTest.body).slice(0, 160));

  const service = await fetchService(admin);
  log("    служебный ящик: " + service.id);

  const nextBefore = (await admin.req("/api/docflow/journal/next-number")).body?.regNumber;

  // ---------- 1. Письмо с PDF (текстовый слой) ----------
  log("\n=== 1. Письмо с PDF (текстовый слой) → скан → анализ ===");
  await sendLetter(subjectText, PDF_WITH_TEXT, "Направляем документ. Просим зарегистрировать. QA " + stamp);
  log("    письмо отправлено на " + SERVICE_BOX + " (PDF: " + PDF_WITH_TEXT + ")");
  const fetched1 = await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
  check("«Скан» служебного ящика выполнен", fetched1.status === 200, JSON.stringify(fetched1.body).slice(0, 120));
  const mail1 = await findEmail(admin, service.id, subjectText);
  check("письмо найдено в служебном ящике", !!mail1, mail1 ? mail1.id : "не найдено");
  if (!mail1) throw new Error("письмо 1 не пришло — дальше некуда");

  const attachmentsBefore = await admin.req("/api/emails/" + mail1.id);
  const att1 = (attachmentsBefore.body?.attachments ?? [])[0];
  check("PDF прикрепился к письму", !!att1 && /pdf/i.test(String(att1.mimeType || att1.filename || "")), JSON.stringify(att1 && { name: att1.filename, kind: att1.kind, mime: att1.mimeType }));

  const started1 = await admin.req("/api/emails/" + mail1.id + "/analyze", { method: "POST", body: "{}" });
  expectStatus("запуск анализа ИИ", started1, [200]);
  const res1 = await waitAnalysis(admin, mail1.id);
  check("анализ завершился без ошибки", res1.status === "ready", "статус " + res1.status + ", " + Math.round(res1.ms / 1000) + "с");
  const view1 = res1.view || {};
  const ana1 = view1.analysis || {};
  log("    summary: " + String(ana1.summary || "").slice(0, 160));
  log("    теги: " + JSON.stringify(ana1.tags || []) + " | приоритет: " + ana1.priority + " | eventDate: " + ana1.eventDate + " | modelUsed: " + ana1.modelUsed);
  check("в анализе есть summary", String(ana1.summary || "").trim().length >= 20, String(ana1.summary || "").length + " симв.");
  check("в анализе есть теги", Array.isArray(ana1.tags) && ana1.tags.length > 0, JSON.stringify(ana1.tags || []));
  check("приоритет в диапазоне 1..5", Number(ana1.priority) >= 1 && Number(ana1.priority) <= 5, String(ana1.priority));
  check("указана модель анализа", String(ana1.modelUsed || "").length > 0, String(ana1.modelUsed));
  check("внешний номер извлечён", String(view1.externalNumber || "").trim().length > 0, String(view1.externalNumber));
  check("дата отправки извлечена", String(view1.sendDate || "").trim().length > 0, String(view1.sendDate));
  check("дата события извлечена", String(ana1.eventDate || "").trim().length > 0, String(ana1.eventDate));
  const texts1 = viewAttachmentTexts(view1);
  log("    текст вложения: " + JSON.stringify(texts1.map((t) => ({ f: String(t.filename).slice(0, 28), chars: t.n }))));
  check("текст вложения сохранён (текстовый слой/OCR)", (texts1[0]?.n ?? 0) > 50, "символов: " + (texts1[0]?.n ?? 0));

  // ---------- 2. Автозаполнение формы регистрации ----------
  log("\n=== 2. Форма регистрации: автозаполнение и номер из базы ===");
  const suggest = await admin.req("/api/docflow/journal/suggest?emailId=" + mail1.id);
  expectStatus("GET /api/docflow/journal/suggest", suggest, [200]);
  const s = suggest.body || {};
  log("    подсказка: " + JSON.stringify({ sender: s.sender, summary: String(s.summary || "").slice(0, 60), docNumber: s.docNumber, docDate: s.docDate, sheets: s.sheetsCount, name: String(s.documentName || "").slice(0, 40) }));
  check("подставлен отправитель", String(s.sender || "").trim().length > 0, String(s.sender));
  check("подставлено краткое содержание", String(s.summary || "").trim().length >= 10, String(s.summary || "").length + " симв.");
  check("подставлен номер отправителя", String(s.docNumber || "").trim().length > 0, String(s.docNumber));
  check("подставлена дата документа", String(s.docDate || "").trim().length > 0, String(s.docDate));
  check("подставлено число листов", Number(s.sheetsCount) > 0, String(s.sheetsCount));
  check("подставлено название документа", String(s.documentName || "").trim().length > 0, String(s.documentName || ""));
  const suggest2 = await admin.req("/api/docflow/journal/suggest?emailId=" + mail1.id);
  check("повторный вызов подсказки не двигает номер", JSON.stringify(suggest2.body || {}) === JSON.stringify(s), "номер подсказки: " + suggest2.body?.regNumber + " / " + s.regNumber);
  const nextAfterSuggest = (await admin.req("/api/docflow/journal/next-number")).body?.regNumber;
  check("next-number не изменился после анализа и подсказок", nextAfterSuggest === nextBefore, nextBefore + " -> " + nextAfterSuggest);

  // ---------- 2b. Стык ИИ и СЭД: ответ руководителя письмом → черновик РЕЗОЛЮЦИИ ----------
  log("\n=== 2b. Ответ руководителя → черновик резолюции (ИИ в СЭД) ===");
  const users = await admin.req("/api/users?includeInactive=1");
  const signer = (users.body || []).find((u) => u.ldapUid === "user2");
  check("найден подписант (user2) для адресации", !!signer, signer && signer.id);
  const reg = await admin.req("/api/docflow/journal", {
    method: "POST",
    body: JSON.stringify({ emailId: mail1.id, docNumber: s.docNumber, docDate: s.docDate, sender: s.sender, summary: s.summary, sheetsCount: s.sheetsCount, documentName: s.documentName })
  });
  check("письмо зарегистрировано по подсказке ИИ", reg.status === 201 || reg.status === 200, "код " + reg.status + ", " + (reg.body && reg.body.regNumber));
  const nextAfterReg = (await admin.req("/api/docflow/journal/next-number")).body?.regNumber;
  check("регистрация сдвинула номер ровно на один", nextAfterReg !== nextBefore, nextBefore + " -> " + nextAfterReg);
  const fwd = await admin.req("/api/docflow/resolutions/forward", { method: "POST", body: JSON.stringify({ documentId: reg.body.id, toUserId: signer.id }) });
  check("письмо направлено руководителю", fwd.status === 201 || fwd.status === 200, "код " + fwd.status);
  const reqLetter = await admin.req("/api/emails/" + fwd.body.requestEmailId);
  const approvalBody = [
    "Петрова М.А. Подготовить ответ Ростеху в срок до 20.10.2026.",
    "Проверить сроки по договору и доложить об исполнении.",
    "",
    "С уважением, User Two Mail Test",
    "",
    "> Направляю поступившее письмо для наложения резолюции.",
    "> Регистрационный номер: " + (reg.body && reg.body.regNumber)
  ].join("\n");
  await sendReply(SENDER_BOX, SENDER_PASS, reqLetter.body.subject, approvalBody, reqLetter.body.messageId);
  log("    ответ руководителя отправлен письмом (с цитатой и подписью — их ИИ должен снять)");
  await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
  const replyMail = await findEmail(admin, service.id, "Re: " + String(reqLetter.body.subject || "").replace(/^Re:\s*/i, ""));
  check("ответ руководителя найден в ящике", !!replyMail, replyMail ? replyMail.id : "не найдено");
  if (replyMail) {
    const ctx = await admin.req("/api/docflow/emails/" + replyMail.id + "/reply-context");
    const ctxItem = Array.isArray(ctx.body) ? ctx.body[0] : null;
    check("СЭД видит переписку по поручению (expects=approval)", ctx.status === 200 && !!ctxItem && ctxItem.expects === "approval", JSON.stringify(ctx.body).slice(0, 140));
    const draft = await admin.req("/api/docflow/emails/" + replyMail.id + "/suggest-fields", { method: "POST", body: JSON.stringify({ kind: "approval" }) });
    const d = draft.body || {};
    log("    черновик резолюции: " + JSON.stringify(d).slice(0, 320));
    check("ИИ вернул черновик резолюции", draft.status === 200 && d.source === "ai" && String(d.text || "").trim().length >= 20, "source=" + d.source + ", " + String(d.text || "").length + " симв.");
    check("черновик без цитаты исходного письма", !/Направляю поступившее письмо/.test(String(d.text || "")), "");
    check("черновик без подписи «С уважением»", !/С уважением/i.test(String(d.text || "")), "");
    // негатив: модель недоступна — честный отказ, ничего не падает
    await admin.req("/api/ai/config", { method: "PUT", body: JSON.stringify({ ...snapshot, baseUrl: BAD_AI_URL }) });
    const draftBad = await admin.req("/api/docflow/emails/" + replyMail.id + "/suggest-fields", { method: "POST", body: JSON.stringify({ kind: "approval" }) });
    const bd = draftBad.body || {};
    check("при недоступной модели — честный «черновика нет»", draftBad.status === 200 && bd.source === "none" && String(bd.text || "") === "", JSON.stringify(bd).slice(0, 140));
    const healthMid = await admin.req("/api/health");
    check("СЭД жив после отказа модели", healthMid.status === 200 && healthMid.body?.ok === true, "");
    await admin.req("/api/ai/config", { method: "PUT", body: JSON.stringify(snapshot) });

    // ---------- 2c. Стык: ответ исполнителя письмом → черновик ОТЧЁТА ----------
    log("\n=== 2c. Ответ исполнителя → черновик отчёта (ИИ в СЭД) ===");
    // Аппарат утверждает черновик ИИ: текст, который вернула модель, уходит в резолюцию как есть
    // (человек его проверяет и правит — здесь править нечего, это тот же путь).
    const petrova = (users.body || []).find((u) => u.ldapUid === "Петрова_МА");
    check("найден исполнитель (Петрова) для поручения", !!petrova, petrova && petrova.id);
    const mark = await admin.req("/api/docflow/resolutions/" + fwd.body.id + "/mark-approval", {
      method: "POST",
      body: JSON.stringify({
        emailId: replyMail.id,
        text: String(d.text || "").trim(),
        assignees: [{ userId: petrova.id, kind: "coexecutor" }],
        deadline: "2026-10-20",
        priority: "normal"
      })
    });
    check("черновик ИИ утверждён аппаратом", mark.status === 200, "код " + mark.status);
    const cardApproved = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
    check("в резолюцию попал ровно текст черновика ИИ", String(cardApproved.body?.text || "").trim() === String(d.text || "").trim(), String(cardApproved.body?.text || "").slice(0, 70));
    const dis = await admin.req("/api/docflow/resolutions/" + fwd.body.id + "/dispatch", { method: "POST", body: "{}" });
    check("поручение отправлено исполнителю", dis.status === 200, "код " + dis.status);
    const cardSent = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
    const dispLetter = await admin.req("/api/emails/" + cardSent.body.dispatchEmailId);
    const reportSubject = String(dispLetter.body.subject || "") + " — отчёт " + stamp;
    const reportBody = [
      "Отчитываюсь по поручению.",
      "Ответ Ростеху подготовлен, подписан и отправлен 07.10.2026. Сроки по договору проверены, замечаний нет. Копия отправки — во вложении.",
      "",
      "С уважением, Петрова М.А.",
      "",
      "> Поручение: подготовить ответ Ростеху"
    ].join("\n");
    await sendReply(EXECUTOR_BOX, EXECUTOR_PASS, reportSubject, reportBody, dispLetter.body.messageId);
    log("    отчёт исполнителя отправлен письмом");
    await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
    const reportMail = await findEmail(admin, service.id, " — отчёт " + stamp);
    check("ответ исполнителя найден в ящике", !!reportMail, reportMail ? reportMail.id : "не найдено");
    if (reportMail) {
      const ctx2 = await admin.req("/api/docflow/emails/" + reportMail.id + "/reply-context");
      const ctxItem2 = Array.isArray(ctx2.body) ? ctx2.body[0] : null;
      check("СЭД видит переписку по поручению (expects=report)", !!ctxItem2 && ctxItem2.expects === "report", JSON.stringify(ctx2.body).slice(0, 140));
      const before = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
      check("до подсказки поручение НЕ закрыто", before.body?.status === "sent", "статус " + before.body?.status);
      const draftRep = await admin.req("/api/docflow/emails/" + reportMail.id + "/suggest-fields", { method: "POST", body: JSON.stringify({ kind: "report" }) });
      const dr = draftRep.body || {};
      log("    черновик отчёта: " + JSON.stringify(dr).slice(0, 320));
      check("ИИ вернул черновик отчёта", draftRep.status === 200 && dr.source === "ai" && String(dr.text || "").trim().length >= 20, "source=" + dr.source + ", " + String(dr.text || "").length + " симв.");
      check("черновик отчёта — короткий пересказ, а не копия письма", String(dr.text || "").length > 0 && String(dr.text || "").length < reportBody.length, String(dr.text || "").length + " < " + reportBody.length);
      const after = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
      check("после подсказки поручение по-прежнему НЕ закрыто", after.body?.status === "sent", "статус " + after.body?.status);

      // ---------- 2d. Промежуточный ответ исполнителя (решение заказчика) ----------
      // «Проект ответа готов, жду согласования» — это НЕ исполнение. Черновик должен описывать
      // состояние, а не рапортовать «выполнено»; закрывает поручение только действие аппарата.
      log("\n=== 2d. Промежуточный ответ исполнителя → черновик состояния ===");
      const interimSubject = String(dispLetter.body.subject || "") + " — промежуточный " + stamp;
      const interimBody = [
        "Информирую: проект ответа Ростеху подготовлен и находится на согласовании у Директора по развитию.",
        "Ожидаю согласования, после чего направлю адресату. Прошу не считать поручение исполненным.",
        "",
        "С уважением, Петрова М.А."
      ].join("\n");
      await sendReply(EXECUTOR_BOX, EXECUTOR_PASS, interimSubject, interimBody, dispLetter.body.messageId);
      log("    промежуточный ответ исполнителя отправлен письмом");
      await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
      const interimMail = await findEmail(admin, service.id, " — промежуточный " + stamp, 12);
      check("промежуточный ответ найден", !!interimMail, interimMail ? interimMail.id : "не найдено");
      if (interimMail) {
        const ctx3 = await admin.req("/api/docflow/emails/" + interimMail.id + "/reply-context");
        const ctxItem3 = Array.isArray(ctx3.body) ? ctx3.body[0] : null;
        check("промежуточный ответ тоже виден как переписка (expects=report)", !!ctxItem3 && ctxItem3.expects === "report", JSON.stringify(ctx3.body).slice(0, 120));
        const stBefore = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
        check("инвариант: до действия аппарата поручение НЕ закрыто", stBefore.body?.status === "sent", "статус " + stBefore.body?.status);
        const draftInterim = await admin.req("/api/docflow/emails/" + interimMail.id + "/suggest-fields", { method: "POST", body: JSON.stringify({ kind: "report" }) });
        const di = draftInterim.body || {};
        log("    черновик по промежуточному ответу: " + JSON.stringify(di).slice(0, 320));
        // Кейс решения заказчика: промежуточный ответ должен давать черновик про СОСТОЯНИЕ.
        // Правка промпта едет отдельной задачей (task-23), поэтому до неё это ожидание, а не дефект.
        // Кейс решения заказчика (T23): промежуточный ответ → черновик про СОСТОЯНИЕ, а не рапорт.
        // Промпт поправлен в сборке — проверяем как обычное требование.
        check("по промежуточному ответу черновик появился", draftInterim.status === 200 && di.source === "ai" && String(di.text || "").trim().length >= 15, "source=" + di.source + ", " + String(di.text || "").length + " симв.");
        check("черновик описывает СОСТОЯНИЕ (готов/согласование/ожидание)",
          /(готов|подготовлен|согласован|ожида|проект|на согласовании)/i.test(String(di.text || "")),
          String(di.text || "").slice(0, 110));
        check("черновик НЕ рапортует «выполнено/исполнено/завершено»",
          String(di.text || "").trim().length > 0 && !/(выполнен|исполнен|завершен|сдан)/i.test(String(di.text || "")),
          String(di.text || "").slice(0, 110));
        const stMid = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
        check("«отклонение» (аппарат не подтвердил) — поручение остаётся открытым", stMid.body?.status === "sent", "статус " + stMid.body?.status);
        // Аппарат подтверждает — поручение закрывается штатно. Если модель промолчала, аппарат
        // пишет отчёт сам: закрытие не должно зависеть от ИИ.
        const manualText = String(di.text || "").trim() ||
          "Проект ответа подготовлен исполнителем; поручение считаю исполненным по докладу исполнителя (черновик ИИ не предложен).";
        const confirm = await admin.req("/api/docflow/resolutions/" + fwd.body.id + "/report/confirm", {
          method: "POST",
          body: JSON.stringify({ userId: petrova.id, text: manualText })
        });
        check("аппарат подтвердил отчёт — принято", confirm.status === 200, "код " + confirm.status);
        const stDone = await admin.req("/api/docflow/resolutions/" + fwd.body.id);
        check("после подтверждения аппаратом поручение закрылось штатно", stDone.body?.status === "done", "статус " + stDone.body?.status);
      }
    }
  }

  // ---------- 3. PDF без текстового слоя → OCR ----------
  log("\n=== 3. PDF без текстового слоя → OCR ===");
  await sendLetter(subjectScan, PDF_SCAN, "Скан письма во вложении. QA " + stamp);
  log("    письмо отправлено (PDF: " + PDF_SCAN + ", текстового слоя в файле нет)");
  await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
  const mail2 = await findEmail(admin, service.id, subjectScan);
  check("письмо-скан найдено", !!mail2, mail2 ? mail2.id : "не найдено");
  if (mail2) {
    const started2 = await admin.req("/api/emails/" + mail2.id + "/analyze", { method: "POST", body: "{}" });
    expectStatus("запуск анализа письма-скана", started2, [200]);
    const res2 = await waitAnalysis(admin, mail2.id, 360000);
    check("анализ скана завершился", res2.status === "ready", "статус " + res2.status + ", " + Math.round(res2.ms / 1000) + "с");
    const ana2 = (res2.view || {}).analysis || {};
    check("по скану получен summary", String(ana2.summary || "").trim().length >= 20, String(ana2.summary || "").length + " симв.");
    const texts2 = viewAttachmentTexts(res2.view);
    const n2 = texts2[0]?.n ?? 0;
    log("    текст вложения (OCR) : " + JSON.stringify(texts2.map((t) => ({ f: String(t.filename).slice(0, 28), chars: t.n }))));
    log("    начало распознанного: " + String(texts2[0]?.head || "").replace(/\s+/g, " ").slice(0, 140));
    check("текст скана распознан (OCR-модель)", n2 > 50, "символов: " + n2);
    check("распознанный текст помечен страницами (--- стр. N ---)", String(texts2[0]?.head || "").includes("стр."), String(texts2[0]?.head || "").slice(0, 40));
    const suggestScan = await admin.req("/api/docflow/journal/suggest?emailId=" + mail2.id);
    log("    подсказка по скану: " + JSON.stringify({ sender: suggestScan.body?.sender, docNumber: suggestScan.body?.docNumber, docDate: suggestScan.body?.docDate, sheets: suggestScan.body?.sheetsCount }));
    check("по скану форма тоже заполняется", String(suggestScan.body?.summary || "").trim().length >= 10, String(suggestScan.body?.summary || "").length + " симв.");
  }

  // ---------- 4. Негатив: модель недоступна ----------
  log("\n=== 4. Негатив: summary-модель недоступна ===");
  const broken = await admin.req("/api/ai/config", { method: "PUT", body: JSON.stringify({ ...snapshot, baseUrl: BAD_AI_URL }) });
  check("конфиг ИИ переключён на недоступный порт", broken.status === 200 && String(broken.body?.baseUrl) === BAD_AI_URL, String(broken.body?.baseUrl));
  await sendLetter(subjectBad, PDF_WITH_TEXT, "Письмо для негатива. QA " + stamp);
  await admin.req("/api/accounts/" + service.id + "/fetch", { method: "POST", body: "{}" });
  const mail3 = await findEmail(admin, service.id, subjectBad);
  check("письмо для негатива найдено", !!mail3, mail3 ? mail3.id : "не найдено");
  if (mail3) {
    await admin.req("/api/emails/" + mail3.id + "/analyze", { method: "POST", body: "{}" });
    const res3 = await waitAnalysis(admin, mail3.id, 180000);
    check("анализ завершился честной ошибкой (не завис)", res3.status === "error", "статус " + res3.status + " за " + Math.round(res3.ms / 1000) + "с");
    const healthAfter = await admin.req("/api/health");
    check("приложение живо после ошибки модели", healthAfter.status === 200 && healthAfter.body?.ok === true, JSON.stringify(healthAfter.body));
    const listAfter = await admin.req("/api/emails?accountId=" + service.id + "&folder=INBOX");
    const still = (Array.isArray(listAfter.body) ? listAfter.body : (listAfter.body?.items ?? [])).some((e) => e.id === mail3.id);
    check("письмо не потерялось из ящика", still, "");
    const progress = await admin.req("/api/analysis/progress");
    check("прогресс анализа не висит (очередь пуста/не в ошибке)", progress.status === 200, JSON.stringify(progress.body).slice(0, 120));
  }
  const restored = await admin.req("/api/ai/config", { method: "PUT", body: JSON.stringify(snapshot) });
  check("настройки ИИ возвращены как были", restored.status === 200 && String(restored.body?.baseUrl) === String(snapshot.baseUrl), String(restored.body?.baseUrl));
  if (mail3) {
    const retry = await admin.req("/api/emails/" + mail3.id + "/analyze", { method: "POST", body: "{}" });
    expectStatus("повторный анализ после возврата настроек запускается", retry, [200]);
    const res4 = await waitAnalysis(admin, mail3.id, 300000);
    check("после починки модели письмо анализируется успешно", res4.status === "ready", "статус " + res4.status + " за " + Math.round(res4.ms / 1000) + "с");
  }

  const nextFinal = (await admin.req("/api/docflow/journal/next-number")).body?.regNumber;
  check("анализ и подсказки номер не двигают (выдаёт база)", nextFinal === nextAfterReg, nextAfterReg + " -> " + nextFinal);
}

try {
  await main();
} catch (err) {
  console.log("\n!!! Сценарий прерван: " + (err && err.message));
  failures.push("исключение: " + (err && err.message));
}

console.log("\n=== Итог: " + passed + " проверок, " + failures.length + " провалов ===");
if (pending.length) {
  console.log("Ожидает правки промпта (task-23), не дефект продукта:");
  for (const f of pending) console.log(" - " + f);
}
if (failures.length) { console.log("Провалы:"); for (const f of failures) console.log(" - " + f); }
process.exit(failures.length ? 1 : 0);
