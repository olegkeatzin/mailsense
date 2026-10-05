
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
 * Сквозной тест резолюций (СЭД, этап 3).
 *
 * Повторяет приёмку этапа: аппарат готовит черновик → отправляет на утверждение →
 * подписант утверждает → аппарат отправляет исполнителям → у исполнителя появляется задача.
 * Отдельно проверяются запреты: без утверждения поручение не уходит, аппарат не утверждает сам.
 *
 * Требуется запущенный сервер с DOCFLOW_DATABASE_URL и MAILSENSE_ADMIN_LOGINS.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";
const LOGIN = process.env.ADMIN_LOGIN ?? "test@stand.test";
const PASSWORD = process.env.ADMIN_PASSWORD ?? standPass("STAND_ADMIN_PASS");
const EMPLOYEE_LOGIN = process.env.EMPLOYEE_LOGIN ?? "Петрова_МА@stand.test";
const EMPLOYEE_PASSWORD = process.env.EMPLOYEE_PASSWORD ?? standPass("STAND_PETROVA_PASS");

let cookie = "";
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log("  OK   " + name);
  } else {
    failed++;
    console.log("  ПРОВАЛ " + name + (detail ? " — " + detail : ""));
  }
}

async function api(path, options = {}, useCookie = cookie) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(useCookie ? { Cookie: useCookie } : {}), ...(options.headers ?? {}) }
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && useCookie !== "") cookie = setCookie.split(";")[0];
  return res;
}

async function json(path, options = {}, useCookie = cookie) {
  const res = await api(path, options, useCookie);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(login_, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: login_, password })
  });
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : "";
}

async function main() {
  console.log("=== Резолюции: сквозной сценарий ===");

  // 1. Вход администратора: у него есть все права, поэтому он может провести
  // весь путь — но каждый запрет проверяется отдельным входом.
  cookie = await login(LOGIN, PASSWORD);
  check("вход администратора", cookie.length > 0);
  if (!cookie) process.exit(1);

  // Внимание: права лежат в user.permissions, а не в корне ответа — на этом уже
  // спотыкался скрипт приёмки.
  const me = await json("/api/auth/me");
  const perms = me.body?.user?.permissions ?? [];
  check("право resolution.approve у администратора", perms.includes("resolution.approve"));
  check("право resolution.dispatch у администратора", perms.includes("resolution.dispatch"));

  // 2. Документ: берём первый из журнала либо регистрируем новый.
  let journal = await json("/api/docflow/journal?limit=1");
  let documentId = journal.body?.items?.[0]?.id;
  if (!documentId) {
    const incoming = await json("/api/docflow/journal/incoming?limit=1");
    const emailId = incoming.body?.items?.[0]?.id;
    if (emailId) {
      const reg = await json("/api/docflow/journal", {
        method: "POST",
        body: JSON.stringify({ emailId, summary: "E2E: документ для резолюции" })
      });
      documentId = reg.body?.id;
    }
  }
  check("документ для резолюции найден", !!documentId, "в журнале и во входящих пусто");
  if (!documentId) {
    console.log("\nНечего проверять: сначала зарегистрируйте хотя бы одно письмо.");
    process.exit(1);
  }

  // 3. Исполнители берутся из справочника пользователей.
  const users = await json("/api/users");
  const list = Array.isArray(users.body) ? users.body : (users.body?.items ?? []);
  const active = list.filter((u) => u.isActive !== false && !u.blocked);
  check("в справочнике есть действующие пользователи", active.length > 0);
  // Без двух действующих учёток проверка «исполнителей двое» ниже не имеет смысла:
  // раньше она в этом случае молча вырождалась в «есть хотя бы один».
  check("в справочнике не меньше двух действующих", active.length >= 2, "найдено " + active.length);
  if (!active.length) process.exit(1);

  const execA = active[0];
  const execB = active[1] ?? active[0];

  // 4. Черновик: ИИ предлагает текст.
  const draft = await json("/api/docflow/resolutions/draft", {
    method: "POST",
    body: JSON.stringify({ documentId })
  });
  const aiOk = draft.status === 200 && typeof draft.body?.text === "string";
  check("ИИ-черновик отвечает без ошибки", aiOk, "статус " + draft.status);
  if (aiOk && draft.body.text) {
    console.log("       предложено символов: " + draft.body.text.length);
  } else {
    console.log("       (модель недоступна или письма нет — идём дальше с ручным текстом)");
  }

  // 5. Создание резолюции аппаратом.
  const created = await json("/api/docflow/resolutions", {
    method: "POST",
    body: JSON.stringify({
      documentId,
      text: draft.body?.text || "1. Рассмотреть вопрос. 2. Подготовить ответ.",
      sourceText: draft.body?.text || "",
      sourceKind: draft.body?.text ? "ai" : "manual",
      priority: "important",
      deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      assignees: [
        { userId: execA.id, kind: "responsible" },
        ...(execB.id !== execA.id ? [{ userId: execB.id, kind: "coexecutor" }] : [])
      ]
    })
  });
  check("черновик создан", created.status === 201, "статус " + created.status + " " + JSON.stringify(created.body).slice(0, 120));
  const id = created.body?.id;
  if (!id) process.exit(1);
  check("состояние черновика", created.body?.status === "draft", created.body?.status);

  // 6. ГЛАВНЫЙ ЗАПРЕТ: неутверждённую резолюцию отправить нельзя.
  const earlyDispatch = await json("/api/docflow/resolutions/" + id + "/dispatch", { method: "POST", body: "{}" });
  check("без утверждения поручение НЕ уходит", earlyDispatch.status === 409, "статус " + earlyDispatch.status);

  // 7. Правка черновика.
  const patched = await json("/api/docflow/resolutions/" + id, {
    method: "PATCH",
    body: JSON.stringify({ text: "1. Рассмотреть вопрос. 2. Подготовить ответ в установленный срок." })
  });
  check("черновик правится", patched.status === 200 && patched.body?.text.includes("установленный срок"));

  // 8. На утверждение.
  const requested = await json("/api/docflow/resolutions/" + id + "/request-approval", { method: "POST", body: "{}" });
  check("отправлено на утверждение", requested.body?.status === "pending_approval", requested.body?.status);

  // 9. После отправки на утверждение текст не меняется.
  const lateEdit = await json("/api/docflow/resolutions/" + id, {
    method: "PATCH",
    body: JSON.stringify({ text: "Подмена после отправки" })
  });
  check("текст после отправки на утверждение НЕ меняется", lateEdit.status === 409, "статус " + lateEdit.status);

  // 10. Очередь подписанта.
  const queue = await json("/api/docflow/resolutions/for-approval");
  check("резолюция видна в очереди подписанта", (queue.body?.items ?? []).some((x) => x.id === id));

  // 11. Утверждение.
  const approved = await json("/api/docflow/resolutions/" + id + "/approve", { method: "POST", body: "{}" });
  check("утверждено", approved.body?.status === "approved", approved.body?.status);
  check("записан, кто утвердил", !!approved.body?.approvedBy);
  check("способ утверждения — приложение", approved.body?.approvalMethod === "app", approved.body?.approvalMethod);

  // 12. Отправка исполнителям.
  const dispatched = await json("/api/docflow/resolutions/" + id + "/dispatch", { method: "POST", body: "{}" });
  check("отправлено исполнителям", dispatched.body?.status === "sent", dispatched.body?.status);
  check("записан, кто отправил", !!dispatched.body?.dispatchedBy);

  // 13. Карточка: исполнители, история, номер документа.
  const card = await json("/api/docflow/resolutions/" + id);
  // Проверяем, что вернулись ИМЕННО те исполнители, которых просили: «>= 1» считало успехом
  // карточку с одним ответственным, то есть потеря соисполнителя не замечалась.
  const cardAssigneeIds = (card.body?.assignees ?? []).map((a) => a.userId);
  const wantedAssigneeIds = execB.id !== execA.id ? [execA.id, execB.id] : [execA.id];
  check("исполнителей двое", cardAssigneeIds.length >= 2 && wantedAssigneeIds.every((u) => cardAssigneeIds.includes(u)),
    "в карточке " + cardAssigneeIds.length + " (" + cardAssigneeIds.join(",") + "), просили " + wantedAssigneeIds.join(","));
  check("ответственный помечен", (card.body?.assignees ?? [])[0]?.kind === "responsible");
  const steps = (card.body?.history ?? []).map((h) => h.step);
  check("история содержит всю цепочку", ["requested", "approved", "dispatched"].every((s) => steps.includes(s)), steps.join(","));
  check("виден номер документа", !!card.body?.documentNumber, card.body?.documentNumber);

  // 14. Канбан.
  const board = await json("/api/docflow/resolutions/board");
  const sentCol = (board.body ?? []).find((c) => c.key === "sent");
  check("резолюция попала в колонку «В работе»", (sentCol?.items ?? []).some((x) => x.id === id));

  // 15. Права: сотрудник без прав не видит резолюции.
  const empCookie = await login(EMPLOYEE_LOGIN, EMPLOYEE_PASSWORD);
  // Проверка ДО ветвления: раньше неудачный вход рядового сотрудника молча выключал весь
  // негативный контроль прав, и прогон всё равно заканчивался успехом.
  check("вход сотрудника для проверки прав", !!empCookie, "не удалось войти как " + EMPLOYEE_LOGIN);
  if (empCookie) {
    const forbidden = await json("/api/docflow/resolutions", {}, empCookie);
    check("рядовой сотрудник не видит список резолюций", forbidden.status === 403, "статус " + forbidden.status);
    const forbiddenApprove = await json("/api/docflow/resolutions/" + id + "/approve", { method: "POST", body: "{}" }, empCookie);
    check("рядовой сотрудник не может утверждать", forbiddenApprove.status === 403, "статус " + forbiddenApprove.status);
  } else {
    console.log("  (вход сотрудника недоступен — проверка прав пропущена)");
  }

  // 16. Аудит: следы всех шагов на месте.
  // Аудит отдаёт entries, а не items — форма ответа отличается от остальных списков.
  const audit = await json("/api/audit?entityType=resolution&entityId=" + id);
  const actions = (audit.body?.entries ?? []).map((a) => a.action);
  check("в аудите есть утверждение", actions.includes("resolution.approve"), actions.join(","));
  check("в аудите есть отправка", actions.includes("resolution.dispatch"));

  console.log("\n=== Итог: " + passed + " успешно, " + failed + " провалено ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Ошибка сценария:", e);
  process.exit(1);
});