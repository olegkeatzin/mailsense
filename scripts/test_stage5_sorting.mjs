#!/usr/bin/env node
/**
 * Пароли стенда — ТОЛЬКО из окружения, в репозитории их быть не должно (уже чистили один раз).
 * Перед запуском задайте нужные переменные, например:
 *   $env:STAND_ADMIN_PASS="..."; $env:STAND_IVANOV_PASS="..."; $env:STAND_PARTNER_PASS="...";
 *   $env:STAND_PETROVA_PASS="..."
 * Список учётных записей — в test mail/README.md.
 */
function standPass(name) {
  const v = process.env[name];
  if (!v) throw new Error("Не задана переменная окружения " + name + " — пароли стенда в репозитории не хранятся");
  return v;
}

/**
 * Сквозной сценарий этапа 5 (СЭД): ПРАВИЛА АВТОСОРТИРОВКИ ПИСЕМ.
 *
 * Проверяет то, ради чего этап делался: правило ставит метку, подсказку и приоритет, поднимает
 * письмо в очереди «Входящих на регистрацию» — и при этом НЕ создаёт документ и НЕ тратит номер
 * (rules.md §6.1: письмо размечает аппарат, документ создаёт человек).
 *
 * Отдельно проверяются: права (settings.manage — только администратор), предпросмотр без записи,
 * фильтр rulesOnly, переключатель сортировки, неактивное правило, валидация границ и аудит
 * каждой мутации правила.
 *
 * Требуется запущенный сервер с DOCFLOW_DATABASE_URL и хотя бы одним письмом во «Входящих».
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";

const ACCOUNTS = {
  admin: { login: "test@stand.test", passEnv: "STAND_ADMIN_PASS" },
  secretary: { login: "Иванов_ИИ@stand.test", passEnv: "STAND_IVANOV_PASS" },
  manager: { login: "partner@stand.test", passEnv: "STAND_PARTNER_PASS" },
  executor: { login: "Петрова_МА@stand.test", passEnv: "STAND_PETROVA_PASS" }
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

/** «Не могу проверить» — это НЕ то же самое, что «проверил, и плохо» (см. test_resolutions.mjs). */
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
    get: (p) => req(p),
    post: (p, b = {}) => req(p, { method: "POST", body: JSON.stringify(b) }),
    put: (p, b = {}) => req(p, { method: "PUT", body: JSON.stringify(b) }),
    patch: (p, b = {}) => req(p, { method: "PATCH", body: JSON.stringify(b) }),
    del: (p) => req(p, { method: "DELETE" }),
    async login() {
      return req("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: account.login, password: standPass(account.passEnv) })
      });
    },
    async perms() {
      const r = await req("/api/auth/me");
      return r.body?.user?.permissions ?? [];
    }
  };
}

function expect(name, result, codes) {
  result = result ?? { status: 0, body: {} };
  const ok = codes.includes(result.status);
  const err = result.body && result.body.error ? " (" + result.body.error + ")" : "";
  check(name, ok, ok ? "" : "получен " + result.status + err + ", ожидался " + codes.join("/"));
  return ok;
}

function fromAddress(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.address ?? "";
}

function fromText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return [v.name, v.address].filter(Boolean).join(" ");
}

const INCOMING = "/api/docflow/journal/incoming?limit=300";

/** Число писем в локальной базе — проверка А8: сортировка писем не рассылает почту. */
async function emailCount(s) {
  const r = await s.get("/api/emails");
  return { status: r.status, count: Array.isArray(r.body) ? r.body.length : null };
}

/** Откаты, которые обязаны выполниться даже при падении сценария. */
let cleanupTasks = [];

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
}

async function main() {
  console.log("=== Этап 5: правила сортировки (сквозной сценарий) ===");

  // ---------- 0. Вход ----------
  const admin = session(ACCOUNTS.admin);
  const loginAdmin = await admin.login();
  check("администратор вошёл", loginAdmin.status === 200, "статус " + loginAdmin.status);
  if (loginAdmin.status !== 200) process.exit(1);

  const smoke = await admin.get("/api/docflow/sorting/rules");
  if (smoke.status !== 200) {
    console.error("Маршруты правил сортировки недоступны (статус " + smoke.status + "). Сервер собран на коде этапа 5 и перезапущен?");
    process.exit(1);
  }
  check("список правил отвечает массивом items", Array.isArray(smoke.body?.items), JSON.stringify(smoke.body).slice(0, 120));

  const secretary = session(ACCOUNTS.secretary);
  const manager = session(ACCOUNTS.manager);
  const executor = session(ACCOUNTS.executor);
  const roles = [["аппарат", secretary], ["руководитель", manager], ["исполнитель", executor]];
  for (const pair of roles) {
    const r = await pair[1].login();
    check(pair[0] + " вошёл", r.status === 200, "статус " + r.status);
  }

  // ---------- 1. Права ----------
  console.log("\n--- права на правила сортировки ---");
  expect("аппарат видит входящие на регистрацию", await secretary.get(INCOMING), [200]);
  expect("исполнителю закрыт список правил", await executor.get("/api/docflow/sorting/rules"), [403]);
  expect("исполнитель НЕ создаёт правило", await executor.post("/api/docflow/sorting/rules", { name: "нельзя", matchFrom: "x" }), [403]);
  expect("исполнитель НЕ правит правило", await executor.patch("/api/docflow/sorting/rules/any-id", { name: "нельзя" }), [403]);
  expect("исполнитель НЕ удаляет правило", await executor.del("/api/docflow/sorting/rules/any-id"), [403]);
  expect("исполнителю закрыт предпросмотр", await executor.post("/api/docflow/sorting/rules/preview", { matchFrom: "x" }), [403]);
  expect("аппарату закрыт список правил (нужно settings.manage)", await secretary.get("/api/docflow/sorting/rules"), [403]);
  expect("аппарат НЕ создаёт правило", await secretary.post("/api/docflow/sorting/rules", { name: "нельзя", matchFrom: "x" }), [403]);
  expect("руководителю закрыт список правил", await manager.get("/api/docflow/sorting/rules"), [403]);

  // ---------- 2. Входящие и состояние «до» ----------
  console.log("\n--- входящие на регистрацию ---");
  const incomingBefore = await secretary.get(INCOMING);
  expect("входящие читаются", incomingBefore, [200]);
  const items = Array.isArray(incomingBefore.body?.items) ? incomingBefore.body.items : [];
  console.log("       писем во «Входящих»: " + items.length);
  // А6: список ограничен 300, интерфейс показывает честную подпись «первые N из total».
  check("А6: список отдаёт total", typeof incomingBefore.body?.total === "number", String(incomingBefore.body?.total));
  const capped = await secretary.get("/api/docflow/journal/incoming?limit=500");
  check("А6: limit больше 300 ограничивается, а не отдаёт всё",
    capped.status === 200 && (capped.body?.items ?? []).length <= 300,
    "статус " + capped.status + ", писем " + (capped.body?.items ?? []).length);
  const clampedZero = await secretary.get("/api/docflow/journal/incoming?limit=0");
  check("А6: limit=0 приводится к границе, а не падает", clampedZero.status === 200, "статус " + clampedZero.status);
  const badLimit = await secretary.get("/api/docflow/journal/incoming?limit=abc");
  check("А6: мусор в limit отвергается с 400", badLimit.status === 400, "статус " + badLimit.status);
  if (items.length) {
    const first = items[0];
    check("у письма есть поля сортировки",
      Array.isArray(first.sortLabels) && Array.isArray(first.sortNotes) && typeof first.sortMatched === "boolean" && "sortPriority" in first,
      JSON.stringify({ sortLabels: first.sortLabels, sortNotes: first.sortNotes, sortMatched: first.sortMatched, sortPriority: first.sortPriority }));
    check("у письма есть emailId и subject", typeof first.emailId === "string" && typeof first.subject === "string", JSON.stringify(first).slice(0, 120));
  } else {
    skip("поля сортировки у писем", "во «Входящих» нет писем");
  }

  const numBefore = await secretary.get("/api/docflow/journal/next-number");
  const journalBefore = await secretary.get("/api/docflow/journal?limit=1");
  const nextBefore = numBefore.body?.regNumber ?? null;
  const totalBefore = typeof journalBefore.body?.total === "number" ? journalBefore.body.total : null;

  // ---------- 3. Правило по отправителю/теме ----------
  console.log("\n--- правило ставит метку ---");
  const stamp = Date.now();
  // Цель выбираем с приоритетом КИРИЛЛИЦЫ в теме: регистронезависимый матчинг без SQL lower()
  // ломается именно на кириллице (rules §5.6), и проверять это надо на живом пути, а не только в core.
  const hasCyr = (s) => /[А-Яа-яЁё]/.test(String(s ?? ""));
  const cyrTarget = items.find((i) => hasCyr(i.subject));
  const target = cyrTarget ?? items[0] ?? null;
  console.log("       кириллица в теме выбранного письма: " + (cyrTarget ? "да" : "нет (в «Входящих» нет темы с кириллицей)"));
  let matcherField = "matchSubject";
  let matcher = target ? String(target.subject ?? "").trim() : "";
  if (!matcher && target) {
    matcherField = "matchFrom";
    matcher = fromAddress(target.from) || fromText(target.from);
  }
  matcher = matcher.slice(0, 100);
  // Регистр намеренно верхний: матчинг обязан быть регистронезависимым и БЕЗ SQL lower() —
  // иначе кириллица (rules.md §5.6) перестаёт находиться.
  const matcherUpper = matcher.toUpperCase();
  const exact = !!matcher && matcherField === "matchSubject" && items.length > 0;
  const norm = (s) => String(s ?? "").toLowerCase();
  const expectedMatched = exact ? items.filter((i) => norm(i.subject).includes(norm(matcher))) : [];

  if (!target || !matcher) {
    skip("правило ставит метку на письме", target ? "у письма нет ни темы, ни отправителя" : "во «Входящих» нет писем");
  } else {
    console.log("       правило: " + matcherField + " = " + JSON.stringify(matcherUpper).slice(0, 80));
    const ruleBody = {
      name: "QA этап5 " + stamp,
      isActive: true,
      sortOrder: 10,
      matchFrom: matcherField === "matchFrom" ? matcherUpper : "",
      matchTo: "",
      matchSubject: matcherField === "matchSubject" ? matcherUpper : "",
      label: "QA-метка-A",
      priority: 4,
      note: "QA: подсказка аппарату"
    };
    const created = await admin.post("/api/docflow/sorting/rules", ruleBody);
    expect("администратор создаёт правило", created, [201]);
    const rule = created.body?.rule;
    check("в ответе есть правило с id", !!rule?.id, JSON.stringify(created.body).slice(0, 140));
    if (rule?.id) {
      cleanupTasks.push(async () => {
        await admin.del("/api/docflow/sorting/rules/" + rule.id);
      });
      check("имя правила сохранилось", rule.name === ruleBody.name, String(rule.name));
      check("метка сохранилась", rule.label === "QA-метка-A", String(rule.label));
      check("приоритет сохранился", rule.priority === 4, String(rule.priority));
      check("правило активно", rule.isActive === true, String(rule.isActive));
    }

    const incomingAfter = await secretary.get(INCOMING);
    const itemsAfter = incomingAfter.body?.items ?? [];
    const targetAfter = itemsAfter.find((i) => i.emailId === target.emailId);
    check("письмо осталось во «Входящих» (правило его не съело)", !!targetAfter);
    check("правило отметило письмо как совпавшее", targetAfter?.sortMatched === true, String(targetAfter?.sortMatched));
    check("метка правила стоит на письме", (targetAfter?.sortLabels ?? []).includes("QA-метка-A"), JSON.stringify(targetAfter?.sortLabels));
    check("приоритет письма поднялся до 4", targetAfter?.sortPriority === 4, String(targetAfter?.sortPriority));
    check("подсказка аппарату видна", (targetAfter?.sortNotes ?? []).includes("QA: подсказка аппарату"), JSON.stringify(targetAfter?.sortNotes));

    if (exact) {
      const matchedIds = expectedMatched.map((i) => i.emailId).sort();
      const reallyMatched = itemsAfter.filter((i) => i.sortMatched === true).map((i) => i.emailId).sort();
      check("совпали ровно письма с этой подстрокой (регистр не важен)",
        JSON.stringify(reallyMatched) === JSON.stringify(matchedIds),
        "ожидали " + matchedIds.length + ", получили " + reallyMatched.length);
      const nonMatched = itemsAfter.filter((i) => i.sortMatched !== true);
      check("у несовпавших писем меток нет", nonMatched.every((i) => (i.sortLabels ?? []).length === 0),
        "писем без метки: " + nonMatched.length);
    } else {
      skip("точный состав совпавших писем", "у писем нет темы — правило по отправителю проверено только по цели");
    }

    // Предпросмотр: ничего не пишет, показывает совпадения.
    const preview = await admin.post("/api/docflow/sorting/rules/preview", ruleBody);
    expect("предпросмотр правила отвечает", preview, [200]);
    const pv = preview.body ?? {};
    check("в предпросмотре есть matched и total", typeof pv.matched === "number" && typeof pv.total === "number", JSON.stringify(pv).slice(0, 140));
    check("в предпросмотре есть samples-массив", Array.isArray(pv.samples), typeof pv.samples);
    check("предпросмотр нашёл хотя бы одно письмо", (pv.matched ?? 0) >= 1, String(pv.matched));
    check("совпадений не больше просканированных", (pv.total ?? 0) >= (pv.matched ?? 0), pv.matched + " из " + pv.total);
    check("samples не больше совпадений", (pv.samples?.length ?? 0) <= (pv.matched ?? 0), String(pv.samples?.length));

    // Фильтр «только по правилам».
    const rulesOnly = await secretary.get("/api/docflow/journal/incoming?limit=300&rulesOnly=1");
    expect("фильтр rulesOnly=1 отвечает", rulesOnly, [200]);
    const ro = rulesOnly.body?.items ?? [];
    check("rulesOnly отдаёт только совпавшие письма", ro.length > 0 && ro.every((i) => i.sortMatched === true),
      "писем " + ro.length + ", без метки " + ro.filter((i) => i.sortMatched !== true).length);
    if (exact) {
      check("rulesOnly отдаёт ровно совпавшие письма", ro.length === expectedMatched.length,
        "получено " + ro.length + ", ожидали " + expectedMatched.length);
    }

    // Сортировка «по правилам» поднимает совпавшие письма наверх.
    const sortedByRules = await secretary.get("/api/docflow/journal/incoming?limit=300&sort=rules");
    expect("сортировка sort=rules отвечает", sortedByRules, [200]);
    const sr = sortedByRules.body?.items ?? [];
    const firstUnmatched = sr.findIndex((i) => i.sortMatched !== true);
    const lastMatched = sr.map((i) => i.sortMatched === true).lastIndexOf(true);
    check("sort=rules поднимает совпавшие письма наверх",
      sr.length === 0 || firstUnmatched === -1 || lastMatched < firstUnmatched,
      "первое несовпавшее " + firstUnmatched + ", последнее совпавшее " + lastMatched);

    const defaultOrder = await secretary.get(INCOMING);
    const dateOrder = await secretary.get("/api/docflow/journal/incoming?limit=300&sort=date");
    check("порядок «по умолчанию» не изменился (sort=date)",
      JSON.stringify((defaultOrder.body?.items ?? []).map((i) => i.emailId)) === JSON.stringify((dateOrder.body?.items ?? []).map((i) => i.emailId)));
    const weird = await secretary.get("/api/docflow/journal/incoming?limit=10&sort=что-попало");
    check("мусор в sort не роняет сервер", weird.status < 500, "статус " + weird.status);

    // Второе правило: порядок меток и максимум приоритета.
    const rule2Body = {
      name: "QA этап5-B " + stamp,
      isActive: true,
      sortOrder: 20,
      matchFrom: matcherField === "matchFrom" ? matcherUpper : "",
      matchTo: "",
      matchSubject: matcherField === "matchSubject" ? matcherUpper : "",
      label: "QA-метка-B",
      priority: 2,
      note: "QA: вторая подсказка"
    };
    const created2 = await admin.post("/api/docflow/sorting/rules", rule2Body);
    expect("второе правило создано", created2, [201]);
    const rule2 = created2.body?.rule;
    if (rule2?.id) {
      cleanupTasks.push(async () => {
        await admin.del("/api/docflow/sorting/rules/" + rule2.id);
      });
      const two = ((await secretary.get(INCOMING)).body?.items ?? []).find((i) => i.emailId === target.emailId);
      check("метки идут в порядке применения правил",
        JSON.stringify(two?.sortLabels ?? []) === JSON.stringify(["QA-метка-A", "QA-метка-B"]),
        JSON.stringify(two?.sortLabels));
      check("дублей меток нет", new Set(two?.sortLabels ?? []).size === (two?.sortLabels ?? []).length, JSON.stringify(two?.sortLabels));
      check("приоритет — максимум из сработавших", two?.sortPriority === 4, String(two?.sortPriority));
      expect("второе правило удалено", await admin.del("/api/docflow/sorting/rules/" + rule2.id), [200]);
      cleanupTasks = cleanupTasks.filter((fn) => !String(fn).includes(rule2.id));
      const afterDelete2 = ((await secretary.get(INCOMING)).body?.items ?? []).find((i) => i.emailId === target.emailId);
      check("после удаления второго правила метка осталась одна",
        JSON.stringify(afterDelete2?.sortLabels ?? []) === JSON.stringify(["QA-метка-A"]), JSON.stringify(afterDelete2?.sortLabels));
    }

    // Неактивное правило не участвует.
    if (rule?.id) {
      expect("правило выключено", await admin.patch("/api/docflow/sorting/rules/" + rule.id, { isActive: false }), [200]);
      const off = ((await secretary.get(INCOMING)).body?.items ?? []).find((i) => i.emailId === target.emailId);
      check("неактивное правило не ставит метку", off?.sortMatched === false && (off?.sortLabels ?? []).length === 0,
        "sortMatched " + String(off?.sortMatched) + ", метки " + JSON.stringify(off?.sortLabels));
      expect("правило включено обратно", await admin.patch("/api/docflow/sorting/rules/" + rule.id, { isActive: true }), [200]);
      const on = ((await secretary.get(INCOMING)).body?.items ?? []).find((i) => i.emailId === target.emailId);
      check("включённое правило снова ставит метку", on?.sortMatched === true, String(on?.sortMatched));
    }

    // Правило, которое ничего не ловит.
    const noMatch = await admin.post("/api/docflow/sorting/rules", {
      name: "QA этап5-мимо " + stamp,
      isActive: true,
      sortOrder: 30,
      matchFrom: "",
      matchTo: "",
      matchSubject: "QA-нет-такого-письма-" + stamp + "-" + Math.random().toString(36).slice(2),
      label: "QA-мимо",
      priority: null,
      note: ""
    });
    expect("правило, которое ничего не ловит, создаётся", noMatch, [201]);
    const noMatchId = noMatch.body?.rule?.id;
    if (noMatchId) {
      cleanupTasks.push(async () => {
        await admin.del("/api/docflow/sorting/rules/" + noMatchId);
      });
      const nm = ((await secretary.get(INCOMING)).body?.items ?? []).find((i) => i.emailId === target.emailId);
      check("правило «мимо» не ставит свою метку", !(nm?.sortLabels ?? []).includes("QA-мимо"), JSON.stringify(nm?.sortLabels));
      expect("правило «мимо» удалено", await admin.del("/api/docflow/sorting/rules/" + noMatchId), [200]);
      cleanupTasks = cleanupTasks.filter((fn) => !String(fn).includes(noMatchId));
    }
  }

  // ---------- 3b. А8: разбор писем правилами не рассылает почту ----------
  console.log("\n--- сортировка не отправляет писем (А8) ---");
  const sortMailBefore = await emailCount(admin);
  await secretary.get(INCOMING);
  await secretary.get("/api/docflow/journal/incoming?limit=300&rulesOnly=1");
  const sortMailAfter = await emailCount(admin);
  if (sortMailBefore.count === null || sortMailAfter.count === null) {
    skip("А8: разбор входящих не отправляет писем", "список писем недоступен: " + sortMailBefore.status + "/" + sortMailAfter.status);
  } else {
    check("А8: разбор входящих не отправляет писем", sortMailBefore.count === sortMailAfter.count,
      "писем было " + sortMailBefore.count + ", стало " + sortMailAfter.count);
  }

  // ---------- 4. Правило НЕ создаёт документ и НЕ тратит номер ----------
  console.log("\n--- правило не создаёт документ и не тратит номер ---");
  const numAfter = await secretary.get("/api/docflow/journal/next-number");
  const journalAfter = await secretary.get("/api/docflow/journal?limit=1");
  const nextAfter = numAfter.body?.regNumber ?? null;
  const totalAfter = typeof journalAfter.body?.total === "number" ? journalAfter.body.total : null;
  check("следующий номер не изменился", nextBefore !== null && nextBefore === nextAfter, String(nextBefore) + " -> " + String(nextAfter));
  check("число документов в журнале не изменилось", totalBefore !== null && totalBefore === totalAfter, String(totalBefore) + " -> " + String(totalAfter));
  if (target) {
    const byEmail = await secretary.get("/api/docflow/journal/by-email/" + target.emailId);
    check("письмо, пойманное правилом, документом не стало", byEmail.body === null, JSON.stringify(byEmail.body).slice(0, 120));
    const stillIncoming = ((await secretary.get(INCOMING)).body?.items ?? []).some((i) => i.emailId === target.emailId);
    check("письмо осталось в очереди на регистрацию", stillIncoming);
  } else {
    skip("письмо не стало документом", "во «Входящих» нет писем");
  }

  // ---------- 5. Валидация ----------
  console.log("\n--- валидация правила ---");
  expect("правило без единого матчера отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "QA пустое " + stamp, matchFrom: "", matchTo: "", matchSubject: "", label: "x", priority: null }), [400]);
  expect("имя длиннее 120 символов отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "я".repeat(121), matchFrom: "qa" }), [400]);
  expect("матчер длиннее 200 символов отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "QA длинный " + stamp, matchFrom: "x".repeat(201) }), [400]);
  expect("метка длиннее 40 символов отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "QA метка " + stamp, matchFrom: "qa", label: "y".repeat(41) }), [400]);
  expect("подсказка длиннее 200 символов отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "QA заметка " + stamp, matchFrom: "qa", note: "z".repeat(201) }), [400]);
  expect("приоритет вне 1..5 отвергается",
    await admin.post("/api/docflow/sorting/rules", { name: "QA приоритет " + stamp, matchFrom: "qa", priority: 7 }), [400]);
  expect("предпросмотр правила без матчеров отвергается",
    await admin.post("/api/docflow/sorting/rules/preview", { matchFrom: "", matchTo: "", matchSubject: "" }), [400]);
  expect("правка несуществующего правила — 404",
    await admin.patch("/api/docflow/sorting/rules/no-such-rule-" + stamp, { name: "нет" }), [404]);
  expect("удаление несуществующего правила — 404",
    await admin.del("/api/docflow/sorting/rules/no-such-rule-" + stamp), [404]);

  // ---------- 6. Аудит мутаций ----------
  console.log("\n--- аудит правил ---");
  const auditCreate = await admin.get("/api/audit?action=sorting.rule.create&limit=10");
  check("создание правила попало в аудит", (auditCreate.body?.entries ?? []).some((a) => a.action === "sorting.rule.create"),
    "записей: " + ((auditCreate.body?.entries ?? []).length));
  const auditUpdate = await admin.get("/api/audit?action=sorting.rule.update&limit=10");
  check("правка правила попала в аудит", (auditUpdate.body?.entries ?? []).some((a) => a.action === "sorting.rule.update"),
    "записей: " + ((auditUpdate.body?.entries ?? []).length));
  const auditDelete = await admin.get("/api/audit?action=sorting.rule.delete&limit=10");
  check("удаление правила попало в аудит", (auditDelete.body?.entries ?? []).some((a) => a.action === "sorting.rule.delete"),
    "записей: " + ((auditDelete.body?.entries ?? []).length));

  // ---------- Итог ----------
  await runCleanup("итог");
  const rulesLeft = ((await admin.get("/api/docflow/sorting/rules")).body?.items ?? []).filter((r) => String(r.name ?? "").startsWith("QA этап5"));
  check("после прогона тестовых правил не осталось", rulesLeft.length === 0, "осталось: " + rulesLeft.map((r) => r.name).join(", "));
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
