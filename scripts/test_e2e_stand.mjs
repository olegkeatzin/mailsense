/**
 * Сквозной сценарий на ЖИВОМ стенде (Samba AD + Postgres + сервер MailSense).
 *
 * Зачем: юнит-тесты подменяют и каталог, и ядро — на них не видно ни настоящего bind'а
 * в AD, ни того, что два работника на одном сервере действительно не видят почту друг друга.
 * Именно этот прогон нашёл баг: маршрут умолчаний читал их из локальной базы, а в серверном
 * режиме они лежат в базе документооборота — ящик создавался пустым и падал на NOT NULL.
 *
 * Как запускать (стенд из "test mail", сервер поднят локально):
 *
 *   $env:DOCFLOW_DATABASE_URL="postgres://mailsense:testpass@127.0.0.1:55432/mailsense_e2e"
 *   $env:MAILSENSE_DATA_DIR=".e2e-data"; $env:MAILSENSE_PORT="8199"
 *   $env:MAILSENSE_LDAP_URL="ldap://127.0.0.1:389"
 *   $env:MAILSENSE_LDAP_BASE_DN="OU=KNIITMU,DC=stand,DC=test"
 *   $env:MAILSENSE_LDAP_LOGIN="ldap-bind@stand.test"; $env:MAILSENSE_LDAP_PASSWORD="LdapBind123!"
 *   $env:MAILSENSE_LDAP_LOGIN_FORMAT="upn"; $env:MAILSENSE_LDAP_UPN_SUFFIX="@stand.test"
 *   $env:MAILSENSE_ADMIN_LOGINS="Иванов_ИИ"; $env:MAILSENSE_DOCFLOW_ENABLED="true"
 *   $env:MAILSENSE_MAIL_DEFAULTS='{"pop3":{"host":"127.0.0.1","port":1110,"tls":"none","authType":"login"},"smtp":{"host":"127.0.0.1","port":1025,"tls":"none","authType":"login"}}'
 *   node packages/server/dist/bin/server.js
 *   node scripts/test_e2e_stand.mjs
 *
 * ⚠️ Учётные данные — стендовые (см. test mail/ldap/seed.sh). В боевом контуре не запускать.
 */


const BASE = "http://127.0.0.1:8199";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
}
async function login(loginName, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: loginName, password })
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = raw.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie, text: await res.text() };
}
function client(cookie) {
  const req = async (method, path, body) => {
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
  return { get: (p) => req("GET", p), post: (p, b) => req("POST", p, b), put: (p, b) => req("PUT", p, b), del: (p) => req("DELETE", p) };
}

const adminLogin = await login("Иванов_ИИ", "IvanovPass123!");
check("вход администратора доменной учёткой (кириллица, ldap://)", adminLogin.status === 200, adminLogin.status + " " + adminLogin.text.slice(0, 80));
const workerLogin = await login("Петрова_МА", "PetrovaPass123!");
check("вход второго работника", workerLogin.status === 200, workerLogin.status + " " + workerLogin.text.slice(0, 80));

const admin = client(adminLogin.cookie);
const worker = client(workerLogin.cookie);

// Кто я
const me = await worker.get("/api/auth/me");
check("сессия работника отвечает", me.status === 200, JSON.stringify(me.data).slice(0, 120));

// Пункт 5: ящик заводится ТОЛЬКО адресом и паролем — остальное из умолчаний .env
const created = await worker.post("/api/accounts", {
  protocol: "pop3",
  username: "petrova_ma@mail.test",
  password: "почтовый-пароль"
});
check("свой ящик заводит работник без ролей (пункты 1 и 5)", created.status === 201, created.status + " " + JSON.stringify(created.data).slice(0, 140));
const account = created.data ?? {};
check("адрес сервера и порт подставились из MAILSENSE_MAIL_DEFAULTS",
  account.host === "127.0.0.1" && account.port === 1110 && account.smtpPort === 1025,
  "host=" + account.host + " port=" + account.port + " smtpPort=" + account.smtpPort);

// Пункт 2: чужой ящик не виден и не читается
const adminList = await admin.get("/api/accounts");
const adminIds = Array.isArray(adminList.data) ? adminList.data.map((a) => a.id) : [];
check("ящик работника НЕ виден администратору в списке", adminList.status === 200 && Array.isArray(adminList.data) && !adminIds.includes(account.id),
  "status=" + adminList.status + " тело=" + JSON.stringify(adminList.data).slice(0, 100));
const foreignGet = await admin.get("/api/emails?accountId=" + account.id);
check("чужой ящик в запросе писем — 404", foreignGet.status === 404, String(foreignGet.status));
const foreignDelete = await admin.del("/api/accounts/" + account.id);
check("чужой ящик не удаляется даже администратором", foreignDelete.status === 404, String(foreignDelete.status));
const ownEmails = await worker.get("/api/emails?accountId=" + account.id);
check("свою почту работник читает без прав роли", ownEmails.status === 200, String(ownEmails.status));

// Пункт 4: администратор назначает АДРЕС для СЭД (без пароля и без ящиков работника)
const userList = await admin.get("/api/users");
const userRows = Array.isArray(userList.data) ? userList.data : (Array.isArray(userList.data?.items) ? userList.data.items : []);
const workerRow = userRows.find((u) => String(u.ldapUid ?? "").toLowerCase() === "петрова_ма" || String(u.email ?? "").includes("petrova"));
check("работник есть в списке пользователей", !!workerRow, "status=" + userList.status + " " + JSON.stringify(userList.data).slice(0, 140));
if (workerRow) {
  const allowance = await admin.put("/api/docflow/users/" + workerRow.id + "/edms-mail-allowance", {
    addresses: ["petrova_ma@mail.test"]
  });
  check("адрес для СЭД назначается строкой (пункт 4)", allowance.status === 200 && (allowance.data?.addresses ?? []).includes("petrova_ma@mail.test"),
    allowance.status + " " + JSON.stringify(allowance.data ?? {}).slice(0, 140));

  // Пункт 6: у работника ящик СЭД виден и готов к отправке — «не настроена отправка» не появляется
  const mine = await worker.get("/api/docflow/my-edms-mail");
  const allowed = mine.data?.allowed ?? [];
  const option = allowed.find((a) => a.username === "petrova_ma@mail.test");
  check("ящик СЭД виден работнику", !!option, JSON.stringify(allowed).slice(0, 140));
  check("у ящика СЭД настроена отправка (нет предупреждения)", option?.smtpReady === true, "smtpReady=" + option?.smtpReady);
  const choose = await worker.put("/api/docflow/my-edms-mail", { accountId: account.id });
  check("работник выбрал свой ящик для СЭД", choose.status === 200 && choose.data?.accountId === account.id,
    choose.status + " " + JSON.stringify(choose.data ?? {}).slice(0, 140));
}

// Пункт 1: конструктор ролей
const catalog = await admin.get("/api/roles/permission-catalog");
check("каталог прав доступен администратору", catalog.status === 200 && Array.isArray(catalog.data) && catalog.data.length > 10,
  "прав: " + (Array.isArray(catalog.data) ? catalog.data.length : "?"));
const roleCreate = await admin.post("/api/roles", { name: "Делопроизводитель", description: "Своя роль", permissions: ["journal.view", "journal.register"] });
check("роль создаётся с правами галочками", roleCreate.status === 201 && (roleCreate.data?.permissions ?? []).length === 2,
  roleCreate.status + " " + JSON.stringify(roleCreate.data ?? {}).slice(0, 140));
const adminImmutable = await admin.put("/api/roles/admin", { permissions: [] });
check("«Администратора» изменить нельзя — 400", adminImmutable.status === 400, adminImmutable.status + " " + JSON.stringify(adminImmutable.data ?? {}).slice(0, 120));
const workerForbidden = await worker.post("/api/roles", { name: "Сам себе роль" });
check("рядовому конструктор ролей закрыт — 403", workerForbidden.status === 403, String(workerForbidden.status));
if (roleCreate.data?.id && workerRow) {
  const assigned = await admin.put("/api/users/" + workerRow.id + "/roles", { roleIds: [roleCreate.data.id] });
  check("созданная роль назначается работнику", assigned.status === 200, assigned.status + " " + JSON.stringify(assigned.data ?? {}).slice(0, 120));
  const deleteAssigned = await admin.del("/api/roles/" + roleCreate.data.id);
  check("назначенную роль удалить нельзя — 400 с объяснением", deleteAssigned.status === 400, deleteAssigned.status + " " + JSON.stringify(deleteAssigned.data ?? {}).slice(0, 120));
}

console.log("=== СКВОЗНОЙ ПРОГОН НА СТЕНДЕ ===");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log((r.ok ? "  OK   " : "  ПРОВАЛ ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
}
console.log("\nитого: " + (results.length - failed) + " из " + results.length + " проверок пройдено");
