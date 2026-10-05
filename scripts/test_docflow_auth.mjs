#!/usr/bin/env node

/**
 * Пароли стенда — ТОЛЬКО из окружения, в репозитории их быть не должно (уже чистили один раз).
 * Перед запуском задайте нужные переменные, например:
 *   $env:STAND_ADMIN_PASS="..."; $env:STAND_IVANOV_PASS="..."
 * Список учётных записей — в test mail/README.md.
 */
function standPass(name) {
  const v = process.env[name];
  if (!v) throw new Error("Не задана переменная окружения " + name + " — пароли стенда в репозитории не хранятся");
  return v;
}

/**
 * E2E-проверка входа и ролей (серверная часть, docflow) (v0.1.4).
 *
 * Требует ПОЛНОСТЬЮ ЧИСТЫЙ экземпляр сервера: скрипт сам настраивает каталог
 * и включает СЭД, что доступно только пока вход не требуется. Для повторного
 * прогона остановите сервер и удалите каталог данных (MAILSENSE_DATA_DIR).
 *
 * ВАЖНО: сервер документооборота должен быть запущен с MAILSENSE_ADMIN_LOGINS,
 * иначе роль администратора никому не выдаётся (первый вошедший админом не становится):
 *   MAILSENSE_ADMIN_LOGINS=test node packages/server/dist/bin/server.js
 *
 * Запуск (автономный сервер):
 *   MAILSENSE_URL=http://127.0.0.1:8123 node scripts/test_docflow_auth.mjs
 *
 * Запуск через клиент, который проксирует документооборот на сервер
 * (почта при этом локальная, поэтому каталог настраиваем на самом сервере):
 *   MAILSENSE_URL=http://127.0.0.1:8133 LDAP_CONFIG_URL=http://127.0.0.1:8131 \
 *     node scripts/test_docflow_auth.mjs
 *
 * Параметры стенда (по умолчанию — локальный Samba AD из «test mail/»):
 *   LDAP_URL, LDAP_BASE_DN, LDAP_UPN_SUFFIX, LDAP_BIND_LOGIN, LDAP_BIND_PASSWORD
 *   EDMS_ADMIN_LOGIN, EDMS_ADMIN_PASSWORD   — доменная учётка администратора
 *   EDMS_USER_LOGIN,  EDMS_USER_PASSWORD    — вторая учётка (кириллический UPN)
 */

const BASE = (process.env.MAILSENSE_URL ?? "http://127.0.0.1:8123").replace(/\/+$/, "");
/**
 * Настройки каталога (ldap.*) живут в почтовом модуле и задаются там, где работает
 * вход. В режиме «почта локально, документооборот на сервере» это САМ СЕРВЕР,
 * поэтому адрес для этой одной настройки можно указать отдельно.
 */
const LDAP_CONFIG_URL = (process.env.LDAP_CONFIG_URL ?? BASE).replace(/\/+$/, "");
const LDAP_BASE = LDAP_CONFIG_URL === BASE ? "" : LDAP_CONFIG_URL;
const LDAP = {
  url: process.env.LDAP_URL ?? "ldaps://127.0.0.1:636",
  baseDn: process.env.LDAP_BASE_DN ?? "OU=KNIITMU,DC=stand,DC=test",
  upnSuffix: process.env.LDAP_UPN_SUFFIX ?? "@stand.test"
};
const BIND = {
  login: process.env.LDAP_BIND_LOGIN ?? "ldap-bind@stand.test",
  password: process.env.LDAP_BIND_PASSWORD ?? standPass("STAND_LDAP_BIND_PASS")
};
const ADMIN = {
  login: process.env.EDMS_ADMIN_LOGIN ?? "test@stand.test",
  password: process.env.EDMS_ADMIN_PASSWORD ?? standPass("STAND_ADMIN_PASS")
};
// Кириллический sAMAccountName/UPN — как в боевом AD (asup.local).
const USER = {
  login: process.env.EDMS_USER_LOGIN ?? "Петрова_МА@stand.test",
  password: process.env.EDMS_USER_PASSWORD ?? standPass("STAND_PETROVA_PASS"),
  email: process.env.EDMS_USER_EMAIL ?? "petrova_ma@mail.test"
};

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("  ok   " + name + (detail ? " — " + detail : ""));
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

/** Мини-клиент с cookie-банкой: Node fetch не хранит cookie сам. */
function makeClient() {
  const jar = new Map();
  return {
    jar,
    cookieHeader() {
      return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
    },
    async req(method, path, body) {
      const headers = {};
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      // Абсолютный URL (например, настройка каталога прямо на сервере) не префиксуем.
      const target = /^https?:\/\//i.test(path) ? path : BASE + path;
      const res = await fetch(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      let data = null;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data };
    },
    get(p) {
      return this.req("GET", p);
    },
    post(p, b) {
      return this.req("POST", p, b ?? {});
    },
    put(p, b) {
      return this.req("PUT", p, b ?? {});
    },
    patch(p, b) {
      return this.req("PATCH", p, b ?? {});
    }
  };
}

async function main() {
  console.log("Стенд: " + BASE + ", каталог " + LDAP.url + " / " + LDAP.baseDn + "\n");

  const anon = makeClient();
  const status = await anon.get("/api/auth/status");
  if (status.data?.docflowEnabled) {
    console.error(
      "СЭД уже включён на этом сервере. Для прогона нужен чистый экземпляр:\n" +
        "  остановите сервер, удалите MAILSENSE_DATA_DIR и запустите снова."
    );
    process.exit(2);
  }
  check("СЭД по умолчанию выключен", status.data.docflowEnabled === false);
  check("справочник пуст (пользователей нет)", status.data.needsBootstrap === true);
  check(
    "список администраторов задан (MAILSENSE_ADMIN_LOGINS)",
    status.data.adminConfigured === true,
    "иначе роль администратора никому не выдаётся"
  );
  check("администратора в системе пока нет", status.data.hasAdmin === false);

  // Пока вход не требуется — настраиваем каталог и включаем СЭД.
  const cfg = await anon.put(
    LDAP_BASE + "/api/directory/settings",
    { ...LDAP, loginFormat: "upn", rejectUnauthorized: false }
  );
  check("каталог настроен", cfg.status === 200 && cfg.data.baseDn === LDAP.baseDn);

  const offLogin = await anon.post("/api/auth/login", { login: ADMIN.login, password: ADMIN.password });
  check("вход при выключенном СЭД отклонён", offLogin.status === 400, offLogin.data?.error);

  const enabled = await anon.put("/api/docflow/settings", { enabled: true });
  check("СЭД включён", enabled.data?.docflowEnabled === true);

  const guard = await anon.get("/api/users");
  check("анонимный доступ к /api/users закрыт", guard.status === 401, "HTTP " + guard.status);

  const meAnon = await anon.get("/api/auth/me");
  check("/api/auth/me без сессии отдаёт 200 и user=null", meAnon.status === 200 && meAnon.data.user === null);

  // --- администратор ---
  const admin = makeClient();
  const login = await admin.post("/api/auth/login", { login: ADMIN.login, password: ADMIN.password });
  check("вход администратора", login.status === 200, login.data?.user?.fullName);
  check(
    "логин из MAILSENSE_ADMIN_LOGINS получил роль admin",
    (login.data?.user?.roles ?? []).includes("admin"),
    "роли: " + ((login.data?.user?.roles ?? []).join(",") || "нет")
  );
  check("права администратора выданы", (login.data?.user?.permissions ?? []).includes("users.manage"));

  const me = await admin.get("/api/auth/me");
  check("/api/auth/me возвращает профиль", me.data?.user?.ldapUid === "test", "ldapUid=" + me.data?.user?.ldapUid);

  // --- кириллический логин (регрессия: SQLite lower() не знает кириллицу) ---
  const user = makeClient();
  const login2 = await user.post("/api/auth/login", { login: USER.login, password: USER.password });
  check("вход кириллическим UPN", login2.status === 200, login2.data?.user?.fullName);
  check("кириллический логин сохранён в профиль", login2.data?.user?.ldapUid === USER.login.split("@")[0], "sam=" + login2.data?.user?.ldapUid);
  check("пользователь без роли получает пустой набор прав", (login2.data?.user?.roles ?? []).length === 0);

  // Повторный вход того же пользователя: раньше падал на UNIQUE(ldap_uid).
  const again = makeClient();
  const relogin = await again.post("/api/auth/login", { login: USER.login, password: USER.password });
  check("повторный вход того же пользователя не падает", relogin.status === 200);
  check("повторный вход не создал дубль", relogin.data?.user?.id === login2.data?.user?.id);

  // --- разграничение прав ---
  check("без прав /api/users отклонён", (await user.get("/api/users")).status === 403);
  check("без прав /api/users/sync отклонён", (await user.post("/api/users/sync")).status === 403);
  check("без прав /api/audit отклонён", (await user.get("/api/audit")).status === 403);
  check(
    "без прав выключение СЭД отклонено",
    (await user.put("/api/docflow/settings", { enabled: false })).status === 403
  );

  // --- неверный пароль ---
  const bad = await makeClient().post("/api/auth/login", { login: ADMIN.login, password: "заведомо-неверный" });
  check("неверный пароль → 401 с понятным текстом", bad.status === 401, bad.data?.error);
  check(
    "сырой ответ AD не утекает наружу",
    typeof bad.data?.error === "string" && !/data\s+[0-9a-f]{3}|DSID|0x[0-9a-f]+/i.test(bad.data.error)
  );

  // --- роли ---
  const roles = await admin.get("/api/roles");
  const roleIds = (roles.data ?? []).map((r) => r.id);
  check("встроенные роли засеяны", ["admin", "secretary", "manager", "executor"].every((r) => roleIds.includes(r)), roleIds.join(","));

  const users = await admin.get("/api/users");
  const target = (users.data ?? []).find((u) => u.email === USER.email);
  check("пользователь виден в списке", !!target);

  const assigned = await admin.put("/api/users/" + target.id + "/roles", { roleIds: ["executor"] });
  check("роль исполнителя назначена", (assigned.data?.roles ?? []).join(",") === "executor");

  const staleSession = await user.get("/api/auth/me");
  check("смена ролей разорвала старые сессии", staleSession.data?.user === null);

  const afterRelogin = await makeClient().post("/api/auth/login", { login: USER.login, password: USER.password });
  const perms = afterRelogin.data?.user?.permissions ?? [];
  check("исполнитель получил права задачи", perms.includes("task.report") && perms.includes("journal.view"), perms.join(","));
  check("исполнитель не получил прав администратора", !perms.includes("users.manage"));

  const selfBlock = await admin.patch("/api/users/" + login.data.user.id, { isActive: false });
  check(
    "нельзя заблокировать самого себя",
    selfBlock.status === 400,
    "HTTP " + selfBlock.status + " " + (selfBlock.data?.error ?? "")
  );

  const clearRoles = await admin.put("/api/users/" + target.id + "/roles", { roleIds: [] });
  check("снятие ролей у не-администратора разрешено", clearRoles.status === 200);

  const blockUser = await admin.patch("/api/users/" + target.id, { isActive: false });
  check("блокировка пользователя работает", blockUser.status === 200 && blockUser.data?.blocked === true);
  const blockedLogin = await makeClient().post("/api/auth/login", { login: USER.login, password: USER.password });
  check("заблокированный пользователь войти не может", blockedLogin.status === 401, blockedLogin.data?.error);
  const unblock = await admin.patch("/api/users/" + target.id, { isActive: true });
  check("разблокировка возвращает доступ", unblock.status === 200 && unblock.data?.blocked === false);

  // --- синхронизация справочника ---
  // Сервисный bind каталога — тоже core-настройка: задаём его там, где работает вход.
  const bind = await admin.post(LDAP_BASE + "/api/directory/login", { login: BIND.login, password: BIND.password });
  check("сервисный bind каталога выполнен", bind.status === 200);

  const sync = await admin.post("/api/users/sync");
  check("синхронизация справочника прошла", sync.status === 200, JSON.stringify(sync.data));
  check("из каталога пришли сотрудники", (sync.data?.total ?? 0) > 0);

  const afterSync = await admin.get("/api/users?includeInactive=1");
  check("справочник пополнен", (afterSync.data ?? []).length >= (sync.data?.total ?? 0));
  check("все пользователи из каталога", (afterSync.data ?? []).every((u) => ["ldap", "local", "manual"].includes(u.source)));

  // --- аудит ---
  const audit = await admin.get("/api/audit?limit=200");
  const actions = new Set((audit.data?.entries ?? []).map((e) => e.action));
  check("аудит пишется", (audit.data?.total ?? 0) > 0, "записей: " + audit.data?.total);
  check("в аудите есть вход", actions.has("login"));
  check("в аудите есть смена ролей", actions.has("user.roles"));
  check("в аудите есть синхронизация", actions.has("directory.sync"));

  // --- выход ---
  await admin.post("/api/auth/logout");
  const afterLogout = await admin.get("/api/auth/me");
  check("после выхода сессия недействительна", afterLogout.data?.user === null);
  check("после выхода защищённый ресурс недоступен", (await admin.get("/api/users")).status === 401);

  console.log("\nИтог: " + passed + " ok, " + failed + " FAIL");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Ошибка прогона: " + (err?.stack ?? err));
  process.exit(1);
});