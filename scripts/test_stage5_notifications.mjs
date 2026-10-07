#!/usr/bin/env node
/**
 * Пароли стенда — ТОЛЬКО из окружения, в репозитории их быть не должно (уже чистили один раз).
 * Перед запуском задайте нужные переменные, например:
 *   $env:STAND_ADMIN_PASS="..."; $env:STAND_PETROVA_PASS="..."; $env:STAND_IVANOV_PASS="...";
 *   $env:STAND_USER2_PASS="..."; $env:STAND_PARTNER_PASS="..."
 * Список учётных записей — в test mail/README.md.
 */
function standPass(name) {
  const v = process.env[name];
  if (!v) throw new Error("Не задана переменная окружения " + name + " — пароли стенда в репозитории не хранятся");
  return v;
}

/**
 * Сквозной сценарий этапа 5 (СЭД): ЦЕНТР УВЕДОМЛЕНИЙ И СРОКИ.
 *
 * Проверяет то, чего не видно в юнит-тестах: живой путь «поручение ушло → исполнителю пришло
 * уведомление → бейдж → прочтение», материализацию сроков (за N дней / сегодня / просрочка)
 * и главные запреты:
 *   - чужое уведомление не читается (404, а не 403 — 403 выдаёт его существование);
 *   - «прочитать все» не трогает чужие строки;
 *   - отчёт и закрытие гасят напоминания о сроке;
 *   - без права notifications.view маршруты закрыты (403).
 *
 * Писем-напоминаний система не отправляет (решение Р11): уведомления живут только в приложении.
 * Требуется запущенный сервер с DOCFLOW_DATABASE_URL и настроенной почтой (dispatch отправляет письмо).
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";

const ACCOUNTS = {
  admin: { login: "test@stand.test", passEnv: "STAND_ADMIN_PASS" },
  secretary: { login: "Иванов_ИИ@stand.test", passEnv: "STAND_IVANOV_PASS" },
  signer: { login: "user2@stand.test", passEnv: "STAND_USER2_PASS" },
  manager: { login: "partner@stand.test", passEnv: "STAND_PARTNER_PASS" },
  executor: { login: "Петрова_МА@stand.test", passEnv: "STAND_PETROVA_PASS" }
};

/** Разделы UI, куда сервер имеет право вести ссылкой из уведомления (контракт §7). */
const ALLOWED_LINKS = ["tasks", "approvals", "confirmation", "board", "journal"];
/**
 * Карта «вид уведомления → раздел UI» (подтверждена Lead'ом по фактическому LINK_BY_KIND).
 * Проверяем её целиком: именно она легко разъезжается при рефакторинге.
 */
const LINK_BY_KIND = {
  "resolution.assigned": "tasks",
  "resolution.approved": "board",
  "resolution.reported": "confirmation",
  "resolution.closed": "journal",
  "resolution.due_soon": "tasks",
  "resolution.due_today": "tasks",
  "resolution.overdue": "tasks",
  "resolution.overdue_escalation": "board"
};
/** Виды уведомлений этапа 5 (контракт §3) — на каждый обязан быть шаблон. */
const KINDS = [
  "resolution.assigned",
  "resolution.approved",
  "resolution.reported",
  "resolution.closed",
  "resolution.due_soon",
  "resolution.due_today",
  "resolution.overdue",
  "resolution.overdue_escalation"
];

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

/**
 * «Не могу проверить» — это НЕ то же самое, что «проверил, и плохо» (см. test_resolutions.mjs).
 * Пропуск виден в выводе и в итоге, и не красит прогон без вины кода.
 */
function skip(name, why) {
  skipped++;
  console.log("  ПРОПУСК " + name + " — " + why);
}

/** Сессия одной роли: свой cookie, никакого общего состояния. */
function session(account) {
  const state = { cookie: "", account };
  async function req(path, options = {}) {
    const res = await fetch(BASE + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(state.cookie ? { Cookie: state.cookie } : {}),
        ...(options.headers ?? {})
      }
    });
    const sc = res.headers.get("set-cookie");
    if (sc) state.cookie = sc.split(";")[0];
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
  return {
    name: account.login,
    state,
    get: (p) => req(p),
    post: (p, b = {}) => req(p, { method: "POST", body: JSON.stringify(b) }),
    put: (p, b = {}) => req(p, { method: "PUT", body: JSON.stringify(b) }),
    patch: (p, b = {}) => req(p, { method: "PATCH", body: JSON.stringify(b) }),
    async login() {
      return req("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: account.login, password: standPass(account.passEnv) })
      });
    },
    async perms() {
      const r = await req("/api/auth/me");
      return r.body?.user?.permissions ?? [];
    },
    async roles() {
      const r = await req("/api/auth/me");
      return r.body?.user?.roles ?? [];
    }
  };
}

/** Ожидание кода: положительное действие и запрет проверяются одинаково. */
function expect(name, result, codes) {
  result = result ?? { status: 0, body: {} };
  const ok = codes.includes(result.status);
  const err = result.body && result.body.error ? " (" + result.body.error + ")" : "";
  check(name, ok, ok ? "" : "получен " + result.status + err + ", ожидался " + codes.join("/"));
  return ok;
}

/** Дата стенда в формате YYYY-MM-DD со сдвигом на offset календарных дней. */
function isoDay(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const LIST = "/api/docflow/notifications?limit=200";

async function notifList(s) {
  return s.get(LIST);
}

async function notifCount(s) {
  const r = await s.get("/api/docflow/notifications/count");
  return { status: r.status, unread: r.body?.unread, body: r.body };
}

/** Число писем в локальной базе — проверка А8: уведомления не уходят письмами. */
async function emailCount(s) {
  const r = await s.get("/api/emails");
  return { status: r.status, count: Array.isArray(r.body) ? r.body.length : null };
}

function findNotif(items, kind, entityId) {
  return items.filter((n) => n.kind === kind && n.entityId === entityId);
}

/** Полный путь поручения: черновик → на утверждение → подпись → отправка исполнителям. */
async function makeSent(secretary, signer, opts) {
  const created = await secretary.post("/api/docflow/resolutions", {
    documentId: opts.documentId,
    text: opts.text,
    sourceKind: "manual",
    priority: "normal",
    deadline: opts.deadline,
    assignees: [{ userId: opts.assigneeId, kind: "responsible" }]
  });
  if (created.status !== 201) return { created };
  const id = created.body?.id;
  const requested = await secretary.post("/api/docflow/resolutions/" + id + "/request-approval");
  const approved = await signer.post("/api/docflow/resolutions/" + id + "/approve");
  const dispatched = await secretary.post("/api/docflow/resolutions/" + id + "/dispatch");
  return { created, id, requested, approved, dispatched };
}

/** Откаты, которые обязаны выполниться даже при падении сценария. */
let cleanupTasks = [];
let roleRestore = null;

async function runCleanup(label) {
  const tasks = cleanupTasks.slice().reverse();
  cleanupTasks = [];
  for (const fn of tasks) {
    try {
      await fn();
    } catch (e) {
      console.error("  (" + label + ": откат не удался — " + (e && e.message ? e.message : e) + ")");
    }
  }
  if (roleRestore) {
    try {
      await roleRestore();
      roleRestore = null;
      console.error("  (" + label + ": роли руководителя восстановлены)");
    } catch (e) {
      console.error("  (" + label + ": НЕ УДАЛОСЬ восстановить роли — " + (e && e.message ? e.message : e) + ")");
    }
  }
}

async function main() {
  console.log("=== Этап 5: уведомления и сроки (сквозной сценарий) ===");

  // ---------- 0. Вход и проверка, что сервер собран на новом коде ----------
  const admin = session(ACCOUNTS.admin);
  const loginAdmin = await admin.login();
  check("администратор вошёл", loginAdmin.status === 200, "статус " + loginAdmin.status);
  if (loginAdmin.status !== 200) process.exit(1);

  const smoke = await admin.get("/api/docflow/notifications?limit=1");
  if (smoke.status !== 200) {
    console.error("Маршруты уведомлений недоступны (статус " + smoke.status + "). Сервер собран на коде этапа 5 и перезапущен?");
    process.exit(1);
  }

  const adminPerms = await admin.perms();
  check("у администратора есть notifications.view", adminPerms.includes("notifications.view"), adminPerms.join(","));
  check("у администратора есть settings.manage", adminPerms.includes("settings.manage"));

  // ---------- 1. Настройки уведомлений ----------
  console.log("\n--- настройки уведомлений ---");
  const settings0 = await admin.get("/api/docflow/notifications/settings");
  expect("настройки уведомлений читаются администратором", settings0, [200]);
  const s0 = settings0.body ?? {};
  check("enabled — булево", typeof s0.enabled === "boolean", String(s0.enabled));
  check("dueSoonDays — число", typeof s0.dueSoonDays === "number", String(s0.dueSoonDays));
  check("шаблоны пришли массивом", Array.isArray(s0.templates), typeof s0.templates);
  const templates = Array.isArray(s0.templates) ? s0.templates : [];
  const tplKeys = templates.map((t) => t.key);
  const missingTpl = KINDS.filter((k) => !tplKeys.includes(k));
  check("шаблоны заведены для всех видов уведомлений", missingTpl.length === 0, "нет: " + missingTpl.join(","));
  const tplAssigned = templates.find((t) => t.key === "resolution.assigned");
  check("шаблон «назначено» непустой", !!tplAssigned && typeof tplAssigned.title === "string" && tplAssigned.title.length > 0,
    tplAssigned ? String(tplAssigned.title) : "шаблона нет");

  // А2: список переменных шаблона отдаёт сервер — UI его не хардкодит.
  const variables = Array.isArray(s0.variables) ? s0.variables : [];
  const varKeys = variables.map((v) => v.key);
  const wantVars = ["regNumber", "summary", "sender", "deadline", "daysLeft", "text", "author"];
  const missVar = wantVars.filter((k) => !varKeys.includes(k));
  check("настройки отдают переменные шаблонов", variables.length > 0 && missVar.length === 0, "нет: " + missVar.join(","));
  check("у переменных есть русские подписи", variables.length > 0 && variables.every((v) => typeof v.title === "string" && v.title.length > 0),
    JSON.stringify(variables.filter((v) => !v.title).map((v) => v.key)));

  // А3: праздничные дни — часть настроек того же маршрута.
  check("праздничные дни приходят массивом", Array.isArray(s0.holidays), typeof s0.holidays);
  check("настройки отдают workdayDeadlines", typeof s0.workdayDeadlines === "boolean", String(s0.workdayDeadlines));

  // Дальше сценарий меняет настройки под себя — вернуть прежние обязан откат.
  const savedSettings = {
    enabled: s0.enabled,
    dueSoonDays: s0.dueSoonDays,
    holidays: Array.isArray(s0.holidays) ? s0.holidays : []
  };
  // workdayDeadlines возвращаем только если сервер его вообще отдаёт.
  const hasWorkdayFlag = typeof s0.workdayDeadlines === "boolean";
  if (hasWorkdayFlag) savedSettings.workdayDeadlines = s0.workdayDeadlines;
  cleanupTasks.push(async () => {
    await admin.put("/api/docflow/notifications/settings", savedSettings);
  });

  expect("настройки сохраняются (enabled, dueSoonDays)", await admin.put("/api/docflow/notifications/settings", { enabled: true, dueSoonDays: 3 }), [200]);
  expect("dueSoonDays больше 30 отвергается", await admin.put("/api/docflow/notifications/settings", { dueSoonDays: 999 }), [400]);
  expect("отрицательный dueSoonDays отвергается", await admin.put("/api/docflow/notifications/settings", { dueSoonDays: -1 }), [400]);
  expect("нечисловой dueSoonDays отвергается", await admin.put("/api/docflow/notifications/settings", { dueSoonDays: "abc" }), [400]);
  expect("праздничные дни сохраняются",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2026-01-01", "2026-05-09"] }), [200]);
  const holSaved = await admin.get("/api/docflow/notifications/settings");
  check("праздничные дни сохранились и вернулись",
    JSON.stringify(holSaved.body?.holidays ?? []) === JSON.stringify(["2026-01-01", "2026-05-09"]),
    JSON.stringify(holSaved.body?.holidays));
  expect("мусор в праздничных днях отвергается (400, а не тихая запись)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["01.01.2026"] }), [400]);
  expect("не-строка в праздничных днях отвергается",
    await admin.put("/api/docflow/notifications/settings", { holidays: [20260101] }), [400]);
  expect("больше 100 праздничных дней отвергается",
    await admin.put("/api/docflow/notifications/settings", {
      holidays: Array.from({ length: 101 }, (_, i) => "2026-01-" + String((i % 28) + 1).padStart(2, "0"))
    }), [400]);
  expect("пустой список праздников допустим",
    await admin.put("/api/docflow/notifications/settings", { holidays: [] }), [200]);
  // А10/D-1: Date.parse переносит несуществующие даты (2026-02-30 -> 2026-03-02), поэтому
  // проверка обязана быть round-trip, иначе мусор тихо попадёт в расчёт рабочих дней.
  expect("несуществующая дата в праздниках отвергается (2026-02-30)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2026-02-30"] }), [400]);
  expect("несуществующая дата в праздниках отвергается (2026-04-31)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2026-04-31"] }), [400]);
  expect("несуществующий месяц отвергается (2026-13-01)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2026-13-01"] }), [400]);
  expect("неформатная дата отвергается (2026-1-1)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2026-1-1"] }), [400]);
  expect("29 февраля високосного года принимается (2028-02-29)",
    await admin.put("/api/docflow/notifications/settings", { holidays: ["2028-02-29"] }), [200]);
  const holAfterBad = await admin.get("/api/docflow/notifications/settings");
  check("отказ не портит сохранённые праздники",
    Array.isArray(holAfterBad.body?.holidays) && holAfterBad.body.holidays.includes("2028-02-29"),
    JSON.stringify(holAfterBad.body?.holidays));
  expect("праздники очищены после проверки",
    await admin.put("/api/docflow/notifications/settings", { holidays: [] }), [200]);
  const auditSettings = await admin.get("/api/audit?action=notifications.settings&limit=5");
  check("изменение настроек попало в аудит", (auditSettings.body?.entries ?? []).some((a) => a.action === "notifications.settings"),
    "записей: " + ((auditSettings.body?.entries ?? []).length));

  // ---------- 2. Остальные роли ----------
  console.log("\n--- права на уведомления ---");
  const secretary = session(ACCOUNTS.secretary);
  const signer = session(ACCOUNTS.signer);
  const executor = session(ACCOUNTS.executor);
  const manager = session(ACCOUNTS.manager);
  const roleSessions = [["аппарат", secretary], ["подписант", signer], ["исполнитель", executor], ["руководитель", manager]];
  for (const pair of roleSessions) {
    const r = await pair[1].login();
    check(pair[0] + " вошёл", r.status === 200, "статус " + r.status);
  }
  const pExec = await executor.perms();
  const pSec = await secretary.perms();
  check("у исполнителя есть notifications.view", pExec.includes("notifications.view"), pExec.join(","));
  check("у аппарата есть notifications.view", pSec.includes("notifications.view"), pSec.join(","));
  check("у исполнителя НЕТ settings.manage", !pExec.includes("settings.manage"));
  expect("исполнителю закрыты настройки уведомлений", await executor.get("/api/docflow/notifications/settings"), [403]);
  expect("аппарату закрыты настройки уведомлений", await secretary.get("/api/docflow/notifications/settings"), [403]);
  expect("исполнитель НЕ меняет настройки уведомлений", await executor.put("/api/docflow/notifications/settings", { dueSoonDays: 1 }), [403]);

  // ---------- 3. Подготовка: документ и исполнитель ----------
  const stamp = new Date().toISOString().slice(0, 19);
  const reg = await secretary.post("/api/docflow/journal", { summary: "Этап 5: уведомления и сроки " + stamp, sender: "QA-стенд" });
  expect("аппарат регистрирует документ", reg, [201]);
  const documentId = reg.body?.id;
  check("документ получил номер", !!reg.body?.regNumber, String(reg.body?.regNumber));
  if (!documentId) {
    console.log("Дальше идти некуда: документ не создан.");
    await runCleanup("выход");
    process.exit(1);
  }

  const users = await admin.get("/api/users?includeInactive=1");
  const allUsers = Array.isArray(users.body) ? users.body : [];
  const byLogin = (login) => {
    const uid = login.split("@")[0].toLowerCase();
    return allUsers.find((u) => (u.ldapUid ?? "").toLowerCase() === uid || (u.email ?? "").toLowerCase() === login.toLowerCase());
  };
  const execUser = byLogin(ACCOUNTS.executor.login);
  check("исполнитель найден в справочнике", !!execUser, ACCOUNTS.executor.login);
  if (!execUser) {
    await runCleanup("выход");
    process.exit(1);
  }

  // ---------- 4. Назначение: уведомление исполнителю ----------
  console.log("\n--- назначение: уведомление исполнителю ---");
  const createdA = await secretary.post("/api/docflow/resolutions", {
    documentId,
    text: "Этап 5: проверить уведомление о назначении",
    sourceKind: "manual",
    priority: "normal",
    deadline: isoDay(2),
    assignees: [{ userId: execUser.id, kind: "responsible" }]
  });
  expect("поручение A создано", createdA, [201]);
  const ridA = createdA.body?.id;
  if (!ridA) {
    console.log("Дальше идти некуда: поручение не создано.");
    await runCleanup("выход");
    process.exit(1);
  }

  const preA = (await notifList(executor)).body?.items ?? [];
  check("до отправки уведомлений о назначении нет", findNotif(preA, "resolution.assigned", ridA).length === 0);
  expect("поручение A отправлено на утверждение", await secretary.post("/api/docflow/resolutions/" + ridA + "/request-approval"), [200]);
  expect("поручение A утверждено подписантом", await signer.post("/api/docflow/resolutions/" + ridA + "/approve"), [200]);
  const secApproved = (await notifList(secretary)).body?.items ?? [];
  check("аппарату пришло уведомление об утверждении", findNotif(secApproved, "resolution.approved", ridA).length === 1,
    "найдено " + findNotif(secApproved, "resolution.approved", ridA).length);

  const cntBefore = await notifCount(executor);
  const mailBeforeDispatch = await emailCount(admin);
  expect("поручение A отправлено исполнителю", await secretary.post("/api/docflow/resolutions/" + ridA + "/dispatch"), [200]);
  // Контрольная проверка к А8: измеритель писем обязан реагировать на реальную отправку,
  // иначе «писем не прибавилось» ничего не доказывает (rules §2.3).
  let mailAfterDispatch = await emailCount(admin);
  if (mailBeforeDispatch.count !== null && mailAfterDispatch.count !== null &&
      !(mailAfterDispatch.count > mailBeforeDispatch.count)) {
    // Отправленное письмо могло ещё не попасть в локальную базу — даём ему мгновение.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    mailAfterDispatch = await emailCount(admin);
  }
  if (mailBeforeDispatch.count === null || mailAfterDispatch.count === null) {
    skip("контрольная проверка А8: отправка поручения письмо создаёт", "список писем недоступен");
  } else {
    check("контрольная проверка А8: отправка поручения письмо создаёт", mailAfterDispatch.count > mailBeforeDispatch.count,
      "писем было " + mailBeforeDispatch.count + ", стало " + mailAfterDispatch.count);
  }
  const afterDispatch = await notifList(executor);
  check("ответ списка уведомлений — items/unread/total",
    Array.isArray(afterDispatch.body?.items) && typeof afterDispatch.body?.unread === "number" && typeof afterDispatch.body?.total === "number",
    JSON.stringify(afterDispatch.body).slice(0, 120));
  check("А4: список отдаёт enabled", typeof afterDispatch.body?.enabled === "boolean", String(afterDispatch.body?.enabled));
  const itemsAfter = afterDispatch.body?.items ?? [];
  const assigned = findNotif(itemsAfter, "resolution.assigned", ridA);
  check("исполнителю пришло уведомление о назначении", assigned.length === 1, "найдено " + assigned.length);
  const nAssigned = assigned[0];
  if (nAssigned) {
    check("у назначения непустой заголовок", typeof nAssigned.title === "string" && nAssigned.title.length > 0, String(nAssigned.title));
    check("у назначения есть текст (строка)", typeof nAssigned.body === "string", typeof nAssigned.body);
    check("важность назначения — info", nAssigned.severity === "info", String(nAssigned.severity));
    check("назначение сразу непрочитано", nAssigned.readAt === null, String(nAssigned.readAt));
    check("ссылка назначения ведёт в «Мои задачи» (карта видов)", nAssigned.link === LINK_BY_KIND["resolution.assigned"], String(nAssigned.link));
    check("дата создания разбирается", !Number.isNaN(Date.parse(nAssigned.createdAt)), String(nAssigned.createdAt));
    check("сущность — resolution", nAssigned.entityType === "resolution", String(nAssigned.entityType));
  }
  const cntAfter = await notifCount(executor);
  check("счётчик непрочитанных вырос после назначения", cntAfter.unread >= cntBefore.unread + 1,
    cntBefore.unread + " -> " + cntAfter.unread);
  check("А4: счётчик /count отдаёт enabled", typeof cntAfter.body?.enabled === "boolean", String(cntAfter.body?.enabled));

  // ---------- 5. Срок «за N дней» ----------
  const dueSoon = findNotif(itemsAfter, "resolution.due_soon", ridA);
  check("за N дней пришло напоминание о сроке", dueSoon.length === 1, "найдено " + dueSoon.length);
  if (dueSoon[0]) {
    check("напоминание о сроке — warning", dueSoon[0].severity === "warning", String(dueSoon[0].severity));
    check("у напоминания верный срок", dueSoon[0].deadline === isoDay(2), String(dueSoon[0].deadline));
    check("daysLeft в пределах срока", typeof dueSoon[0].daysLeft === "number" && dueSoon[0].daysLeft > 0 && dueSoon[0].daysLeft <= 3,
      String(dueSoon[0].daysLeft));
    check("ссылка due_soon — tasks", dueSoon[0].link === LINK_BY_KIND["resolution.due_soon"], String(dueSoon[0].link));
  }

  const idem1 = await notifCount(executor);
  const idemList = await notifList(executor);
  const idem2 = await notifCount(executor);
  check("повторное чтение не плодит уведомления (dedupe_key)", idem1.unread === idem2.unread, idem1.unread + " -> " + idem2.unread);
  check("напоминание о сроке ровно одно", findNotif(idemList.body?.items ?? [], "resolution.due_soon", ridA).length === 1);

  const listNow = await notifList(executor);
  const totalNow = listNow.body?.total;
  const itemsNow = listNow.body?.items ?? [];
  const cntNow = await notifCount(executor);
  if (typeof totalNow === "number" && totalNow <= itemsNow.length) {
    check("счётчик /count равен числу непрочитанных в списке", cntNow.unread === itemsNow.filter((n) => n.readAt === null).length,
      "счётчик " + cntNow.unread + ", в списке " + itemsNow.filter((n) => n.readAt === null).length);
  } else {
    skip("счётчик /count равен числу непрочитанных в списке", "уведомлений больше страницы (" + totalNow + ")");
  }

  // ---------- 6. Сроки: сегодня и просрочка ----------
  console.log("\n--- сроки: сегодня и просрочка ---");
  const resB = await makeSent(secretary, signer, { documentId, text: "Этап 5: срок сегодня", deadline: isoDay(0), assigneeId: execUser.id });
  expect("поручение B со сроком «сегодня» отправлено", resB.dispatched, [200]);
  const resC = await makeSent(secretary, signer, { documentId, text: "Этап 5: просроченное поручение", deadline: isoDay(-3), assigneeId: execUser.id });
  expect("поручение C с прошедшим сроком отправлено", resC.dispatched, [200]);

  const afterDeadlines = (await notifList(executor)).body?.items ?? [];
  const dueToday = findNotif(afterDeadlines, "resolution.due_today", resB.id);
  check("по сроку «сегодня» пришло уведомление", dueToday.length === 1, "найдено " + dueToday.length);
  if (dueToday[0]) {
    check("«сегодня» — daysLeft 0", dueToday[0].daysLeft === 0, String(dueToday[0].daysLeft));
    check("«сегодня» — warning", dueToday[0].severity === "warning", String(dueToday[0].severity));
    check("ссылка due_today — tasks", dueToday[0].link === LINK_BY_KIND["resolution.due_today"], String(dueToday[0].link));
  }
  check("просроченная задача НЕ считается «сегодня»", findNotif(afterDeadlines, "resolution.due_today", resC.id).length === 0);
  check("просроченная задача НЕ напоминает «за N дней»", findNotif(afterDeadlines, "resolution.due_soon", resC.id).length === 0);
  const overdue = findNotif(afterDeadlines, "resolution.overdue", resC.id);
  check("по просрочке пришло уведомление", overdue.length === 1, "найдено " + overdue.length);
  if (overdue[0]) {
    check("просрочка — daysLeft < 0", typeof overdue[0].daysLeft === "number" && overdue[0].daysLeft < 0, String(overdue[0].daysLeft));
    check("просрочка — danger", overdue[0].severity === "danger", String(overdue[0].severity));
    check("ссылка overdue — tasks", overdue[0].link === LINK_BY_KIND["resolution.overdue"], String(overdue[0].link));
  }
  const secAfterDeadlines = (await notifList(secretary)).body?.items ?? [];
  const escalation = findNotif(secAfterDeadlines, "resolution.overdue_escalation", resC.id);
  check("аппарату пришла эскалация просрочки", escalation.length === 1, "найдено " + escalation.length);
  if (escalation[0]) {
    check("эскалация — danger", escalation[0].severity === "danger", String(escalation[0].severity));
    check("ссылка эскалации — board", escalation[0].link === LINK_BY_KIND["resolution.overdue_escalation"], String(escalation[0].link));
  }
  const approvedToSecretary = findNotif(secApproved, "resolution.approved", ridA)[0];
  check("ссылка «утверждено» — board", approvedToSecretary?.link === LINK_BY_KIND["resolution.approved"], String(approvedToSecretary?.link));

  // А5: порог «скоро срок» в «Моих задачах» — тот же dueSoonDays, что у уведомления.
  const myTasks = await executor.get("/api/docflow/resolutions/my-tasks");
  const taskList = Array.isArray(myTasks.body) ? myTasks.body : [];
  const taskA = taskList.find((t) => t.resolutionId === ridA);
  const taskC = taskList.find((t) => t.resolutionId === resC.id);
  check("А5: задача отдаёт флаг dueSoon", !!taskA && typeof taskA.dueSoon === "boolean", JSON.stringify(taskA ?? {}).slice(0, 120));
  if (taskA) check("А5: скоро срок — dueSoon=true", taskA.dueSoon === true, String(taskA.dueSoon));
  if (taskC) check("А5: просроченная задача — dueSoon=false", taskC.dueSoon === false, String(taskC.dueSoon));

  // А11: карточка поручения отдаёт daysLeft и dueSoon — канбан не заводит свой порог.
  const cardA = await secretary.get("/api/docflow/resolutions/" + ridA);
  check("А11: карточка отдаёт daysLeft и dueSoon",
    typeof cardA.body?.daysLeft === "number" && typeof cardA.body?.dueSoon === "boolean",
    JSON.stringify({ daysLeft: cardA.body?.daysLeft, dueSoon: cardA.body?.dueSoon }));
  check("А11: скоро срок — dueSoon=true и daysLeft>0",
    cardA.body?.dueSoon === true && typeof cardA.body?.daysLeft === "number" && cardA.body.daysLeft > 0,
    JSON.stringify({ daysLeft: cardA.body?.daysLeft, dueSoon: cardA.body?.dueSoon }));
  const cardC = await secretary.get("/api/docflow/resolutions/" + resC.id);
  check("А11: просрочка — dueSoon=false и daysLeft<0",
    cardC.body?.dueSoon === false && typeof cardC.body?.daysLeft === "number" && cardC.body.daysLeft < 0,
    JSON.stringify({ daysLeft: cardC.body?.daysLeft, dueSoon: cardC.body?.dueSoon }));

  // ---------- 6b. А8: чтение уведомлений не отправляет писем ----------
  console.log("\n--- уведомления не отправляют письма (А8) ---");
  const mailBefore = await emailCount(admin);
  await notifList(executor);
  await notifCount(executor);
  await notifList(secretary);
  await notifCount(secretary);
  let mailAfter = await emailCount(admin);
  if (mailBefore.count !== null && mailAfter.count !== null && mailBefore.count !== mailAfter.count) {
    // Почтовый ящик мог догрузиться фоновой синхронизацией — перемеряем, прежде чем красить.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    mailAfter = await emailCount(admin);
  }
  if (mailBefore.count === null || mailAfter.count === null) {
    skip("А8: чтение уведомлений не отправляет писем", "список писем недоступен: " + mailBefore.status + "/" + mailAfter.status);
  } else {
    check("А8: чтение уведомлений не отправляет писем", mailBefore.count === mailAfter.count,
      "писем было " + mailBefore.count + ", стало " + mailAfter.count);
  }

  // ---------- 7. Прочтение одного ----------
  console.log("\n--- прочтение ---");
  if (nAssigned) {
    const beforeRead = await notifCount(executor);
    const readOne = await executor.post("/api/docflow/notifications/" + nAssigned.id + "/read");
    expect("отметка «прочитано» отвечает", readOne, [200]);
    check("в ответе unread уменьшился на 1", readOne.body?.unread === beforeRead.unread - 1,
      "было " + beforeRead.unread + ", стало " + readOne.body?.unread);
    const countAfterRead = await notifCount(executor);
    check("счётчик /count совпал с ответом на прочтение", countAfterRead.unread === readOne.body?.unread,
      "/count " + countAfterRead.unread + ", в ответе " + readOne.body?.unread);
    const afterReadItems = (await notifList(executor)).body?.items ?? [];
    const readItem = afterReadItems.find((n) => n.id === nAssigned.id);
    check("у прочитанного появился readAt", !!readItem?.readAt, String(readItem?.readAt));
    const reread = await executor.post("/api/docflow/notifications/" + nAssigned.id + "/read");
    check("повторное прочтение не меняет счётчик", reread.status === 200 && reread.body?.unread === countAfterRead.unread,
      "статус " + reread.status + ", unread " + reread.body?.unread);
  } else {
    skip("прочтение одного уведомления", "уведомление о назначении не найдено");
  }

  // ---------- 8. Чужое уведомление недоступно ----------
  console.log("\n--- чужое уведомление недоступно ---");
  const execItems = (await notifList(executor)).body?.items ?? [];
  const foreignTarget = execItems.find((n) => n.readAt === null);
  if (foreignTarget) {
    const foreign = await secretary.post("/api/docflow/notifications/" + foreignTarget.id + "/read");
    check("чужое уведомление не читается (404, а не 403)", foreign.status === 404, "статус " + foreign.status);
    const stillUnread = ((await notifList(executor)).body?.items ?? []).find((n) => n.id === foreignTarget.id);
    check("после чужой попытки уведомление всё ещё непрочитано", !!stillUnread && stillUnread.readAt === null, String(stillUnread?.readAt));
    const secItems = (await notifList(secretary)).body?.items ?? [];
    check("чужого уведомления нет в списке аппарата", !secItems.some((n) => n.id === foreignTarget.id));
  } else {
    skip("чужое уведомление недоступно", "у исполнителя нет непрочитанных уведомлений");
  }
  const bogus = await executor.post("/api/docflow/notifications/no-such-notification-" + Date.now() + "/read");
  check("несуществующее уведомление — 404", bogus.status === 404, "статус " + bogus.status);

  // ---------- 9. Прочитать все ----------
  console.log("\n--- прочитать все ---");
  const secUnreadBefore = (await notifCount(secretary)).unread;
  const beforeAll = await notifCount(executor);
  const readAll = await executor.post("/api/docflow/notifications/read-all");
  expect("«прочитать все» отвечает", readAll, [200]);
  check("после «прочитать все» unread = 0", readAll.body?.unread === 0, String(readAll.body?.unread));
  check("обновлено ровно столько, сколько было непрочитано", readAll.body?.updated === beforeAll.unread,
    "было " + beforeAll.unread + ", обновлено " + readAll.body?.updated);
  check("счётчик после «прочитать все» = 0", (await notifCount(executor)).unread === 0);
  const allReadItems = (await notifList(executor)).body?.items ?? [];
  check("все уведомления исполнителя прочитаны", allReadItems.every((n) => n.readAt !== null),
    "непрочитанных: " + allReadItems.filter((n) => n.readAt === null).length);
  const secUnreadAfter = (await notifCount(secretary)).unread;
  check("«прочитать все» не тронуло чужие уведомления", secUnreadAfter === secUnreadBefore,
    secUnreadBefore + " -> " + secUnreadAfter);

  // ---------- 10. Отчёт гасит напоминания ----------
  console.log("\n--- отчёт и закрытие гасят напоминания ---");
  const resD = await makeSent(secretary, signer, { documentId, text: "Этап 5: отчёт гасит напоминания", deadline: isoDay(0), assigneeId: execUser.id });
  expect("поручение D отправлено исполнителю", resD.dispatched, [200]);
  const reportD = await executor.post("/api/docflow/resolutions/" + resD.id + "/report", { text: "Отчёт по D: выполнено (QA)" });
  expect("исполнитель отчитался по D", reportD, [200]);
  check("после отчёта ответственного поручение закрыто", reportD.body?.status === "done", String(reportD.body?.status));
  const dItems = (await notifList(executor)).body?.items ?? [];
  check("назначение по D исполнитель видел", findNotif(dItems, "resolution.assigned", resD.id).length === 1);
  check("после отчёта нет напоминания «сегодня»", findNotif(dItems, "resolution.due_today", resD.id).length === 0);
  check("после отчёта нет напоминания о просрочке", findNotif(dItems, "resolution.overdue", resD.id).length === 0);
  const secD = (await notifList(secretary)).body?.items ?? [];
  const reportedToSecretary = findNotif(secD, "resolution.reported", resD.id)[0];
  check("аппарату пришло уведомление об отчёте", findNotif(secD, "resolution.reported", resD.id).length === 1);
  check("А1: уведомление об отчёте ведёт аппарата в раздел «На подтверждении»",
    reportedToSecretary?.link === LINK_BY_KIND["resolution.reported"], String(reportedToSecretary?.link));
  expect("А1: очередь «На подтверждении» открыта аппарату",
    await secretary.get("/api/docflow/resolutions/for-confirmation"), [200]);
  expect("А1: очередь «На подтверждении» закрыта исполнителю",
    await executor.get("/api/docflow/resolutions/for-confirmation"), [403]);
  const signerD = (await notifList(signer)).body?.items ?? [];
  check("подписанту пришло уведомление об отчёте", findNotif(signerD, "resolution.reported", resD.id).length === 1);

  // ---------- 11. Закрытие гасит напоминания ----------
  const resE = await makeSent(secretary, signer, { documentId, text: "Этап 5: закрытие гасит напоминания", deadline: isoDay(-7), assigneeId: execUser.id });
  expect("поручение E отправлено исполнителю", resE.dispatched, [200]);
  const closeE = await secretary.post("/api/docflow/resolutions/" + resE.id + "/close", { comment: "Закрыто аппаратом без отчёта в приложении (QA)" });
  expect("аппарат закрыл поручение E", closeE, [200]);
  check("E в состоянии done", closeE.body?.status === "done", String(closeE.body?.status));
  const eItems = (await notifList(executor)).body?.items ?? [];
  check("после закрытия нет напоминания о просрочке", findNotif(eItems, "resolution.overdue", resE.id).length === 0);
  check("после закрытия нет «за N дней»", findNotif(eItems, "resolution.due_soon", resE.id).length === 0);
  check("исполнителю пришло уведомление о закрытии", findNotif(eItems, "resolution.closed", resE.id).length === 1);
  const signerE = (await notifList(signer)).body?.items ?? [];
  check("подписанту пришло уведомление о закрытии", findNotif(signerE, "resolution.closed", resE.id).length === 1);
  const secE = (await notifList(secretary)).body?.items ?? [];
  check("после закрытия нет эскалации просрочки у аппарата", findNotif(secE, "resolution.overdue_escalation", resE.id).length === 0);
  check("«закрыто» не уходит аппарату как исполнителю", findNotif(secE, "resolution.closed", resE.id).length === 0);
  const closedToExecutor = findNotif(eItems, "resolution.closed", resE.id)[0];
  check("ссылка «закрыто» — journal", closedToExecutor?.link === LINK_BY_KIND["resolution.closed"], String(closedToExecutor?.link));

  // ---------- 11b. Карта ссылок целиком: все 8 видов ----------
  console.log("\n--- карта ссылок LINK_BY_KIND ---");
  const seenKinds = new Set();
  const wrongLinks = [];
  const strayLinks = [];
  for (const pair of [["исполнителя", executor], ["аппарата", secretary], ["подписанта", signer], ["руководителя", manager]]) {
    const list = (await notifList(pair[1])).body?.items ?? [];
    for (const n of list) {
      if (n.link !== null && !ALLOWED_LINKS.includes(n.link)) strayLinks.push(pair[0] + " " + n.kind + " → " + String(n.link));
      if (LINK_BY_KIND[n.kind] === undefined) continue;
      seenKinds.add(n.kind);
      if (n.link !== LINK_BY_KIND[n.kind]) wrongLinks.push(pair[0] + " " + n.kind + " → " + String(n.link) + " (ждали " + LINK_BY_KIND[n.kind] + ")");
    }
  }
  check("сервер не отдаёт ссылок вне замороженного набора", strayLinks.length === 0, strayLinks.slice(0, 4).join("; "));
  check("у всех известных видов уведомлений ссылка из карты", wrongLinks.length === 0, wrongLinks.slice(0, 4).join("; "));
  const missingKinds = Object.keys(LINK_BY_KIND).filter((k) => !seenKinds.has(k));
  check("сценарий получил уведомления всех 8 видов (карта проверена целиком)", missingKinds.length === 0,
    "не встретились: " + missingKinds.join(","));

  // ---------- 12. Настройка «за N дней» управляет напоминанием ----------
  console.log("\n--- настройка «за N дней» ---");
  const resF = await makeSent(secretary, signer, { documentId, text: "Этап 5: настройка dueSoonDays", deadline: isoDay(2), assigneeId: execUser.id });
  expect("поручение F отправлено исполнителю", resF.dispatched, [200]);
  expect("dueSoonDays = 1 сохранён", await admin.put("/api/docflow/notifications/settings", { dueSoonDays: 1 }), [200]);
  const fOff = ((await notifList(executor)).body?.items ?? []);
  check("при «за 1 день» срок +2 дня не напоминает", findNotif(fOff, "resolution.due_soon", resF.id).length === 0);
  expect("dueSoonDays = 3 сохранён", await admin.put("/api/docflow/notifications/settings", { dueSoonDays: 3 }), [200]);
  const fOn = ((await notifList(executor)).body?.items ?? []);
  check("при «за 3 дня» срок +2 дня напоминает", findNotif(fOn, "resolution.due_soon", resF.id).length === 1);

  // ---------- 13. Выключатель уведомлений ----------
  console.log("\n--- выключатель уведомлений ---");
  const resG = await makeSent(secretary, signer, { documentId, text: "Этап 5: выключатель уведомлений", deadline: isoDay(0), assigneeId: execUser.id });
  expect("поручение G отправлено исполнителю", resG.dispatched, [200]);
  expect("уведомления выключены", await admin.put("/api/docflow/notifications/settings", { enabled: false }), [200]);
  const gOff = await notifList(executor);
  check("при выключенных уведомлениях список читается", gOff.status === 200, "статус " + gOff.status);
  check("А4: при выключенных уведомлениях список отдаёт enabled=false", gOff.body?.enabled === false, String(gOff.body?.enabled));
  const gOffCount = await notifCount(executor);
  check("А4: при выключенных уведомлениях счётчик отдаёт enabled=false", gOffCount.body?.enabled === false, String(gOffCount.body?.enabled));
  check("при выключенных уведомлениях напоминание о сроке не создаётся",
    findNotif(gOff.body?.items ?? [], "resolution.due_today", resG.id).length === 0);
  expect("уведомления включены обратно", await admin.put("/api/docflow/notifications/settings", { enabled: true }), [200]);
  const gOn = ((await notifList(executor)).body?.items ?? []);
  check("после включения напоминание о сроке появилось", findNotif(gOn, "resolution.due_today", resG.id).length === 1);

  // ---------- 13b. А9: типовые сроки в рабочих днях ----------
  console.log("\n--- типовые сроки (рабочие дни, А9) ---");
  expect("исполнителю закрыты типовые сроки", await executor.get("/api/docflow/deadline-presets"), [403]);
  // ⚠️ Подписанту маршрут ОТКРЫТ: это условие фикса D4 (иначе очередь «На утверждении» получала 403
  // на каждой карточке, и подписант не мог выбрать типовой срок). Раньше здесь ожидался 403 — ожидание устарело.
  const presetsSigner = await signer.get("/api/docflow/deadline-presets");
  expect("подписанту типовые сроки ОТКРЫТЫ (условие фикса D4)", presetsSigner, [200]);
  check("подписанту приходят те же пресеты, что и поручающему",
    Array.isArray(presetsSigner.body?.items) && presetsSigner.body.items.length >= 3,
    "пунктов: " + (Array.isArray(presetsSigner.body?.items) ? presetsSigner.body.items.length : "нет"));
  expect("кривой from отвергается", await secretary.get("/api/docflow/deadline-presets?from=2026-2-3"), [400]);
  expect("мусор в from отвергается", await secretary.get("/api/docflow/deadline-presets?from=abc"), [400]);
  const presetsDefault = await secretary.get("/api/docflow/deadline-presets");
  expect("типовые сроки отвечают без from", presetsDefault, [200]);
  check("в ответе есть workdayDeadlines и holidays",
    typeof presetsDefault.body?.workdayDeadlines === "boolean" && Array.isArray(presetsDefault.body?.holidays),
    JSON.stringify(presetsDefault.body).slice(0, 160));
  const presetItems = Array.isArray(presetsDefault.body?.items) ? presetsDefault.body.items : [];
  check("типовые сроки пришли списком (не меньше трёх)", presetItems.length >= 3, "пунктов: " + presetItems.length);
  check("у каждого срока есть id/title/days/isWorkday/dueDate",
    presetItems.length > 0 && presetItems.every((x) => typeof x.id === "string" && typeof x.title === "string" &&
      typeof x.days === "number" && typeof x.isWorkday === "boolean" && /^\d{4}-\d{2}-\d{2}$/.test(String(x.dueDate))),
    JSON.stringify(presetItems[0] ?? {}).slice(0, 160));
  const workPreset = presetItems.find((x) => x.days === 3 && x.isWorkday === true);
  const calPreset = presetItems.find((x) => x.isWorkday === false);
  check("есть срок «3 рабочих дня»", !!workPreset, JSON.stringify(presetItems.map((x) => x.title)));
  check("есть календарный срок («30 календарных дней»)", !!calPreset, JSON.stringify(presetItems.map((x) => x.title)));

  const calendarAdd = (iso, days) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  let friday = null;
  for (let i = 0; i < 14 && !friday; i++) {
    const day = calendarAdd("2026-03-02", i);
    if (new Date(day + "T00:00:00Z").getUTCDay() === 5) friday = day;
  }
  if (!friday || !workPreset) {
    skip("рабочие дни отличаются от календарных", friday ? "нет срока «3 рабочих дня»" : "не нашёл пятницу в календаре");
  } else {
    expect("рабочие дни включены, праздники пусты",
      await admin.put("/api/docflow/notifications/settings", { workdayDeadlines: true, holidays: [] }), [200]);
    const p0 = await secretary.get("/api/docflow/deadline-presets?from=" + friday);
    expect("типовые сроки с явным from отвечают", p0, [200]);
    const items0 = p0.body?.items ?? [];
    const due0 = items0.find((x) => x.days === 3 && x.isWorkday === true)?.dueDate;
    const calendar3 = calendarAdd(friday, 3);
    check("в пятницу рабочие дни не короче календарных (выходные пропущены)",
      !!due0 && due0 > calendar3, "from " + friday + ": рабочие " + String(due0) + ", календарные " + calendar3);
    check("срок в рабочих днях попадает на будний день",
      !!due0 && [1, 2, 3, 4, 5].includes(new Date(due0 + "T00:00:00Z").getUTCDay()), String(due0));
    const calDue = items0.find((x) => x.isWorkday === false)?.dueDate;
    check("календарный срок считается календарно",
      !!calPreset && calDue === calendarAdd(friday, calPreset.days),
      "получено " + String(calDue) + ", ждали " + (calPreset ? calendarAdd(friday, calPreset.days) : "?"));
    // Праздник в первый рабочий день обязан сдвинуть срок в рабочих днях.
    expect("праздник сохранён", await admin.put("/api/docflow/notifications/settings", { workdayDeadlines: true, holidays: [calendar3] }), [200]);
    const p1 = await secretary.get("/api/docflow/deadline-presets?from=" + friday);
    const due1 = (p1.body?.items ?? []).find((x) => x.days === 3 && x.isWorkday === true)?.dueDate;
    check("праздничный день сдвигает срок в рабочих днях",
      !!due0 && !!due1 && due1 > due0, "без праздника " + String(due0) + ", с праздником " + String(due1));
    expect("праздники очищены", await admin.put("/api/docflow/notifications/settings", { holidays: [] }), [200]);
    if (hasWorkdayFlag) {
      expect("рабочие дни выключены", await admin.put("/api/docflow/notifications/settings", { workdayDeadlines: false }), [200]);
      const p2 = await secretary.get("/api/docflow/deadline-presets?from=" + friday);
      check("при выключенных рабочих днях срок равен календарному",
        (p2.body?.items ?? []).find((x) => x.days === 3)?.dueDate === calendar3,
        "получено " + String((p2.body?.items ?? []).find((x) => x.days === 3)?.dueDate) + ", ждали " + calendar3);
      expect("рабочие дни включены обратно",
        await admin.put("/api/docflow/notifications/settings", { workdayDeadlines: true }), [200]);
    } else {
      skip("выключатель рабочих дней проверяется через типовые сроки",
        "GET настроек не отдаёт workdayDeadlines — нечем выключить");
    }
  }

  // ---------- 14. Без права notifications.view ----------
  console.log("\n--- без права notifications.view ---");
  const mgrUser = byLogin(ACCOUNTS.manager.login);
  if (!mgrUser) {
    skip("без права notifications.view", "руководитель не найден в справочнике");
  } else {
    const savedRoles = Array.isArray(mgrUser.roles) ? mgrUser.roles : [];
    check("у руководителя есть роль до проверки", savedRoles.length > 0, savedRoles.join(","));
    roleRestore = async () => {
      await admin.put("/api/users/" + mgrUser.id + "/roles", { roleIds: savedRoles });
    };
    expect("администратор временно снял роли у руководителя", await admin.put("/api/users/" + mgrUser.id + "/roles", { roleIds: [] }), [200]);
    const noRole = session(ACCOUNTS.manager);
    const noRoleLogin = await noRole.login();
    check("пользователь без роли вошёл (права не выданы)", noRoleLogin.status === 200, "статус " + noRoleLogin.status);
    const noRolePerms = await noRole.perms();
    check("у пользователя без роли нет notifications.view", !noRolePerms.includes("notifications.view"), noRolePerms.join(","));
    expect("без notifications.view список уведомлений — 403", await noRole.get("/api/docflow/notifications"), [403]);
    expect("без notifications.view счётчик — 403", await noRole.get("/api/docflow/notifications/count"), [403]);
    expect("без notifications.view «прочитать все» — 403", await noRole.post("/api/docflow/notifications/read-all"), [403]);
    expect("без notifications.view настройки — 403", await noRole.get("/api/docflow/notifications/settings"), [403]);
    await roleRestore();
    roleRestore = null;
    const restored = session(ACCOUNTS.manager);
    await restored.login();
    check("роль руководителя восстановлена", (await restored.perms()).includes("notifications.view"));
    check("после восстановления список уведомлений доступен", (await restored.get("/api/docflow/notifications")).status === 200);
  }

  // ---------- Итог ----------
  await runCleanup("итог");
  console.log("\n=== Итог: " + passed + " проверок, " + failed + " провалов" + (skipped ? ", " + skipped + " пропущено" : "") + " ===");
  if (failures.length) {
    console.log("\nПровалы:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Ошибка сценария:", e);
  await runCleanup("ошибка");
  process.exit(1);
});
