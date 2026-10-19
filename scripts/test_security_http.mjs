/**
 * Проверка ГРАНИЦ ДОСТУПА на ЖИВОМ сервере — то, что можно запустить на своём контуре.
 *
 * Зачем: сквозные сценарии проверяют «как задумано», и они проходили, пока в продукте были
 * утечка ящиков и выдача прав не туда. Здесь наоборот — скрипт ПЫТАЕТСЯ нарушить границы
 * и печатает реальные коды ответов. Ничего не «подтверждает»: видно каждое решение сервера.
 *
 * Запуск (нужны две учётки: администратор и рядовой работник):
 *
 *   node scripts/test_security_http.mjs http://127.0.0.1:8123 \
 *        Иванов_ИИ 'пароль' Петрова_МА 'пароль'
 *
 * ⚠️ Скрипт СОЗДАЁТ служебный ящик администратора и пробный ящик работника, а в конце их
 * удаляет. На боевом контуре запускайте, когда это допустимо (или с тестовыми учётками).
 */
const [baseArg, adminLogin, adminPass, workerLogin, workerPass] = process.argv.slice(2);
if (!baseArg || !adminLogin || !adminPass || !workerLogin || !workerPass) {
  console.error("Использование: node scripts/test_security_http.mjs <URL> <логин админа> <пароль> <логин работника> <пароль>");
  process.exit(2);
}
const BASE = baseArg.replace(/\/+$/, "");
const results = [];

function check(name, actual, allowed, detail = "") {
  const ok = allowed.includes(actual);
  results.push({ name, actual, allowed, ok, detail });
  console.log((ok ? "  OK   " : "  ПРОВАЛ ") + name + "  → " + actual + (detail ? "   (" + detail + ")" : ""));
}

async function login(login, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, password })
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("вход не удался: " + login + " (" + res.status + ")");
  return cookie;
}

function client(cookie) {
  const go = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  return { get: (p) => go("GET", p), post: (p, b) => go("POST", p, b), put: (p, b) => go("PUT", p, b), del: (p) => go("DELETE", p) };
}

const anon = client("");
const adminCookie = await login(adminLogin, adminPass);
const workerCookie = await login(workerLogin, workerPass);
const admin = client(adminCookie);
const worker = client(workerCookie);

// Права работника — от них зависит, что считать ожидаемым.
const me = await worker.get("/api/auth/me");
const perms = (me.data && me.data.user && me.data.user.permissions) || [];
const privileged = perms.includes("users.manage");
const runId = Date.now().toString(36);

// Служебный ящик администратора — цель атак.
const probe = await admin.post("/api/accounts", {
  protocol: "pop3",
  username: "probe-" + runId + "@mail.test",
  password: "probe-parol"
});
const target = probe.data && probe.data.id;
if (!target) throw new Error("не удалось создать пробный ящик администратора: " + JSON.stringify(probe).slice(0, 200));
console.log("пробный ящик администратора:", target);

console.log("\n— без входа —");
check("почта без входа", (await anon.get("/api/emails")).status, [401]);
check("пользователи без входа", (await anon.get("/api/users")).status, [401]);

console.log("\n— чужой ящик (у работника его быть не должно) —");
check("письма чужого ящика", (await worker.get("/api/emails?accountId=" + target)).status, [404]);
check("удалить чужой ящик", (await worker.del("/api/accounts/" + target)).status, [404]);
check("изменить чужой ящик", (await worker.put("/api/accounts/" + target, { username: "x" })).status, [404]);
check("забрать почту с чужого ящика", (await worker.post("/api/accounts/" + target + "/fetch")).status, [404]);
check("выбрать чужой ящик для СЭД", (await worker.put("/api/docflow/my-edms-mail", { accountId: target })).status, [403, 404]);

console.log("\n— привилегии —");
check("список пользователей", (await worker.get("/api/users")).status, privileged ? [200] : [403], privileged ? "у работника есть users.manage" : "без прав");
check("создать роль", (await worker.post("/api/roles", { name: "проба-" + runId, permissions: ["users.manage"] })).status, privileged ? [201, 400] : [403]);
check("сменить умолчания почты", (await worker.put("/api/mail-defaults", { smtp: { host: "evil.example" } })).status, [403], privileged ? "но умолчания — только settings.manage" : "без прав");
check("выдать себе админа", (await worker.put("/api/users/" + ((me.data && me.data.user && me.data.user.id) || "x") + "/roles", { roleIds: ["admin"] })).status, [403, 404]);

console.log("\n— подмена владельца —");
const spoof = await worker.post("/api/accounts", {
  protocol: "pop3",
  username: "spoof-" + runId + "@mail.test",
  password: "parol",
  ownerUserId: "подставной"
});
check("ящик с подставным владельцем создан у СЕБЯ", spoof.status, [201]);
const spoofId = spoof.data && spoof.data.id;
check("подставной ящик НЕ виден администратору", (await admin.get("/api/accounts")).data.some((a) => a.id === spoofId) ? 200 : 404, [404], "если бы владелец подменился, ящик достался бы админу");

// Уборка: не оставляем мусор в чужой базе.
if (spoofId) await worker.del("/api/accounts/" + spoofId);
await admin.del("/api/accounts/" + target);

const failed = results.filter((r) => !r.ok);
console.log("\nитого: " + (results.length - failed.length) + " из " + results.length + " попыток нарушить границу — отбито");
if (failed.length) {
  console.log("НЕ ОТБИТО:");
  for (const f of failed) console.log("  " + f.name + " → " + f.actual + " (ожидали " + f.allowed.join("/") + ")");
  process.exit(1);
}
