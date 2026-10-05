
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
 * Сквозной тест по РОЛЯМ (СЭД, этапы 2–3).
 *
 * Каждая роль проходит весь путь целиком: что ей можно — проверяется, что нельзя — тоже.
 * Отрицательные проверки здесь не менее важны положительных: смысл разделения ролей
 * в том, что аппарат НЕ утверждает, подписант НЕ отправляет, а исполнитель НЕ регистрирует.
 *
 * Роли назначаются администратором в начале прогона, поэтому тест самодостаточен.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";

/** Учётные данные стенда: логин — UPN из каталога. */
const ACCOUNTS = {
  admin: { login: "test@stand.test", password: standPass("STAND_ADMIN_PASS"), roles: ["admin"] },
  secretary: { login: "Иванов_ИИ@stand.test", password: standPass("STAND_IVANOV_PASS"), roles: ["secretary"] },
  signer: { login: "user2@stand.test", password: standPass("STAND_USER2_PASS"), roles: ["signer"] },
  manager: { login: "partner@stand.test", password: standPass("STAND_PARTNER_PASS"), roles: ["manager"] },
  executor: { login: "Петрова_МА@stand.test", password: standPass("STAND_PETROVA_PASS"), roles: ["executor"] }
};

let passed = 0;
let failed = 0;
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
    patch: (p, b = {}) => req(p, { method: "PATCH", body: JSON.stringify(b) }),
    put: (p, b = {}) => req(p, { method: "PUT", body: JSON.stringify(b) }),
    async login() {
      const r = await req("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: account.login, password: account.password })
      });
      return r;
    },
    async perms() {
      const r = await req("/api/auth/me");
      return r.body?.user?.permissions ?? [];
    }
  };
}

/** Ожидание кода: положительное действие и запрет проверяются одинаково. */
function expect(name, result, codes) {
  const ok = codes.includes(result.status);
  const err = result.body?.error ? " (" + result.body.error + ")" : "";
  check(name, ok, ok ? "" : "получен " + result.status + err + ", ожидался " + codes.join("/"));
  return ok;
}

async function main() {
  console.log("=== Сквозной тест по ролям ===");

  // ---------- 0. Администратор: подготовка ----------
  const admin = session(ACCOUNTS.admin);
  const loginAdmin = await admin.login();
  check("администратор вошёл", loginAdmin.status === 200, "статус " + loginAdmin.status);
  if (loginAdmin.status !== 200) process.exit(1);

  const ROLE_KEYS = ["secretary", "signer", "manager", "executor"];

  // Шаг 1. Первый вход каждой роли. Он не только проверяет пароль: учётка заводится
  // в базе документооборота из каталога именно в этот момент. До первого входа такого
  // пользователя в справочнике просто нет — и назначить ему роль некому.
  const sess = {};
  for (const key of ROLE_KEYS) {
    sess[key] = session(ACCOUNTS[key]);
    const r = await sess[key].login();
    check(key + ": первый вход выполнен (учётка заведена из каталога)", r.status === 200,
      "статус " + r.status + (r.body?.error ? " " + r.body.error : ""));
  }

  // Шаг 2. Теперь все учётки видны — назначаем роли.
  const users = await admin.get("/api/users?includeInactive=1");
  const all = Array.isArray(users.body) ? users.body : [];
  check("справочник пользователей доступен", all.length > 0, "получено " + all.length);

  const byLogin = (login) => {
    const uid = login.split("@")[0].toLowerCase();
    return all.find(
      (u) => (u.ldapUid ?? "").toLowerCase() === uid || (u.email ?? "").toLowerCase() === login.toLowerCase()
    );
  };

  // Роли администратора не трогаем: он выдаёт их себе же и потерял бы права посреди теста.
  for (const key of ROLE_KEYS) {
    const acc = ACCOUNTS[key];
    const u = byLogin(acc.login);
    if (!u) {
      check("учётка " + key + " найдена в справочнике", false, acc.login);
      continue;
    }
    const r = await admin.put("/api/users/" + u.id + "/roles", { roleIds: acc.roles });
    check("роль " + acc.roles[0] + " назначена (" + acc.login + ")", r.status === 200, "статус " + r.status);
  }

  // Шаг 3. Смена ролей рвёт сессии пользователя (так и задумано — иначе старая сессия
  // несла бы устаревший набор прав). Поэтому входим заново и получаем актуальные права.
  for (const key of ROLE_KEYS) {
    sess[key] = session(ACCOUNTS[key]);
    const r = await sess[key].login();
    check(key + ": повторный вход с новой ролью", r.status === 200, "статус " + r.status);
  }

  const pSecretary = await sess.secretary.perms();
  const pSigner = await sess.signer.perms();
  const pManager = await sess.manager.perms();
  const pExecutor = await sess.executor.perms();

  console.log("\n--- права, выданные ролями ---");
  check("аппарат: есть register и dispatch", pSecretary.includes("journal.register") && pSecretary.includes("resolution.dispatch"));
  check("аппарат: НЕТ права утверждать", !pSecretary.includes("resolution.approve"));
  check("подписант: есть approve", pSigner.includes("resolution.approve"));
  check("подписант: НЕТ права отправлять", !pSigner.includes("resolution.dispatch"));
  check("руководитель: есть approve и create", pManager.includes("resolution.approve") && pManager.includes("resolution.create"));
  check("руководитель: НЕТ права вести журнал", !pManager.includes("journal.register") && !pManager.includes("journal.edit"));
  check("исполнитель: есть task.view и task.report", pExecutor.includes("task.view") && pExecutor.includes("task.report"));
  check("исполнитель: НЕТ права создавать резолюции", !pExecutor.includes("resolution.create"));

  // ---------- 2. Документ: регистрирует аппарат ----------
  console.log("\n--- аппарат: журнал ---");
  expect("аппарат видит журнал", await sess.secretary.get("/api/docflow/journal?limit=5"), [200]);
  expect("руководитель видит журнал", await sess.manager.get("/api/docflow/journal?limit=5"), [200]);
  expect("исполнитель видит журнал", await sess.executor.get("/api/docflow/journal?limit=5"), [200]);
  expect("руководитель НЕ регистрирует в журнал", await sess.manager.post("/api/docflow/journal", { summary: "Попытка руководителя" }), [403]);
  expect("исполнитель НЕ регистрирует в журнал", await sess.executor.post("/api/docflow/journal", { summary: "Попытка исполнителя" }), [403]);

  const stamp = new Date().toISOString().slice(0, 19);
  const reg = await sess.secretary.post("/api/docflow/journal", {
    summary: "Сквозной тест по ролям " + stamp,
    sender: "Тестовый отправитель"
  });
  expect("аппарат регистрирует документ", reg, [201]);
  const documentId = reg.body?.id;
  check("документ получил номер", !!reg.body?.regNumber, reg.body?.regNumber);
  if (!documentId) {
    console.log("\nДальше идти некуда: документ не создан.");
    process.exit(1);
  }

  // ---------- 3. Резолюция: готовит аппарат ----------
  console.log("\n--- аппарат: резолюция ---");
  const execUser = byLogin(ACCOUNTS.executor.login);
  const mgrUser = byLogin(ACCOUNTS.manager.login);
  const deadline = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);

  const resBody = {
    documentId,
    text: "1. Подготовить ответ. 2. Направить в установленный срок.",
    priority: "important",
    deadline,
    assignees: [
      { userId: execUser.id, kind: "responsible" },
      { userId: mgrUser.id, kind: "coexecutor" }
    ]
  };

  expect("исполнитель НЕ создаёт резолюцию", await sess.executor.post("/api/docflow/resolutions", resBody), [403]);
  expect("подписант НЕ создаёт резолюцию", await sess.signer.post("/api/docflow/resolutions", resBody), [403]);

  const created = await sess.secretary.post("/api/docflow/resolutions", resBody);
  expect("аппарат создаёт черновик", created, [201]);
  const rid = created.body?.id;
  if (!rid) process.exit(1);
  check("черновик в состоянии draft", created.body?.status === "draft", created.body?.status);

  expect("аппарат НЕ утверждает свою же резолюцию", await sess.secretary.post("/api/docflow/resolutions/" + rid + "/approve"), [403]);
  expect("аппарат НЕ отправляет неутверждённое", await sess.secretary.post("/api/docflow/resolutions/" + rid + "/dispatch"), [409]);
  expect("подписант НЕ утверждает черновик", await sess.signer.post("/api/docflow/resolutions/" + rid + "/approve"), [409]);

  expect("аппарат отправляет на утверждение", await sess.secretary.post("/api/docflow/resolutions/" + rid + "/request-approval"), [200]);

  // ---------- 4. Утверждение: только подписант ----------
  console.log("\n--- подписант: утверждение ---");
  const queue = await sess.signer.get("/api/docflow/resolutions/for-approval");
  check("резолюция в очереди подписанта", (queue.body?.items ?? []).some((x) => x.id === rid));
  expect("аппарат НЕ видит очередь подписанта", await sess.secretary.get("/api/docflow/resolutions/for-approval"), [403]);
  expect("исполнитель НЕ видит очередь подписанта", await sess.executor.get("/api/docflow/resolutions/for-approval"), [403]);
  expect("подписант утверждает", await sess.signer.post("/api/docflow/resolutions/" + rid + "/approve"), [200]);
  expect("подписант НЕ отправляет исполнителям", await sess.signer.post("/api/docflow/resolutions/" + rid + "/dispatch"), [403]);

  // Проверяем именно ЭТУ резолюцию: у исполнителя могли остаться задачи от прошлых прогонов.
  const beforeDispatch = await sess.executor.get("/api/docflow/resolutions/my-tasks");
  check(
    "до отправки этой задачи у исполнителя нет",
    !(beforeDispatch.body ?? []).some((t) => t.resolutionId === rid),
    "задач всего: " + (beforeDispatch.body ?? []).length
  );

  // ---------- 5. Отправка: только аппарат ----------
  console.log("\n--- аппарат: отправка ---");
  expect("руководитель НЕ отправляет исполнителям", await sess.manager.post("/api/docflow/resolutions/" + rid + "/dispatch"), [403]);
  expect("аппарат отправляет исполнителям", await sess.secretary.post("/api/docflow/resolutions/" + rid + "/dispatch"), [200]);

  // ---------- 6. Исполнение: исполнитель ----------
  console.log("\n--- исполнитель: задача ---");
  const tasks = await sess.executor.get("/api/docflow/resolutions/my-tasks");
  const task = (tasks.body ?? []).find((t) => t.resolutionId === rid);
  check("задача появилась у исполнителя", !!task);
  if (task) {
    check("исполнитель помечен ответственным", task.kind === "responsible", task.kind);
    check("виден номер документа", task.documentNumber === reg.body.regNumber, task.documentNumber);
    check("виден срок", !!task.deadline);
  }
  expect("исполнитель ставит расписку", await sess.executor.post("/api/docflow/resolutions/" + rid + "/received"), [200]);
  expect("исполнитель НЕ утверждает", await sess.executor.post("/api/docflow/resolutions/" + rid + "/approve"), [403]);
  expect("исполнитель НЕ отправляет", await sess.executor.post("/api/docflow/resolutions/" + rid + "/dispatch"), [403]);

  const afterReceipt = await sess.executor.get("/api/docflow/resolutions/my-tasks");
  const t2 = (afterReceipt.body ?? []).find((t) => t.resolutionId === rid);
  check("расписка зафиксирована", !!t2?.receivedAt, String(t2?.receivedAt));

  // ---------- 7. Руководитель: канбан ----------
  console.log("\n--- руководитель: контроль ---");
  const board = await sess.manager.get("/api/docflow/resolutions/board");
  const inWork = (board.body ?? []).find((c) => c.key === "sent");
  check("руководитель видит резолюцию в работе", (inWork?.items ?? []).some((x) => x.id === rid));

  // ---------- 8. Прослеживаемость ----------
  console.log("\n--- прослеживаемость ---");
  const audit = await admin.get("/api/audit?entityType=resolution&entityId=" + rid + "&limit=50");
  const actions = (audit.body?.entries ?? []).map((a) => a.action);
  check("в аудите есть создание", actions.includes("resolution.create"), actions.join(","));
  check("в аудите есть утверждение", actions.includes("resolution.approve"));
  check("в аудите есть отправка", actions.includes("resolution.dispatch"));
  const approveEntry = (audit.body?.entries ?? []).find((a) => a.action === "resolution.approve");
  // Сравниваем с id подписанта и ОТДЕЛЬНО с id аппарата. Раньше вторая проверка смотрела на
  // администратора, поэтому «утвердил кто угодно, кроме админа» проходило как успех, а пустой
  // userId (записи нет вовсе) давал undefined !== id — тоже успех. Здесь оба случая краснеют.
  const signerUser = byLogin(ACCOUNTS.signer.login);
  const secretaryUser = byLogin(ACCOUNTS.secretary.login);
  const approveWho = approveEntry
    ? approveEntry.userId + " (" + approveEntry.userName + ")"
    : "записи об утверждении нет";
  check("утвердил именно подписант", !!approveEntry && approveEntry.userId === signerUser?.id,
    "в аудите " + approveWho + ", подписант " + (signerUser?.id ?? "не найден в справочнике"));
  check("аппарат НЕ утверждал", !!approveEntry && approveEntry.userId !== secretaryUser?.id,
    "в аудите " + approveWho + ", аппарат " + (secretaryUser?.id ?? "не найден в справочнике"));

  const card = await admin.get("/api/docflow/resolutions/" + rid);
  check("в карточке видно, кто подготовил", !!card.body?.preparedByName, card.body?.preparedByName);
  check("в карточке видно, кто утвердил", !!card.body?.approvedByName, card.body?.approvedByName);
  check("в карточке видно, кто отправил", !!card.body?.dispatchedByName, card.body?.dispatchedByName);
  check("подготовил и утвердил — разные люди", card.body?.preparedByName !== card.body?.approvedByName,
    card.body?.preparedByName + " / " + card.body?.approvedByName);

  // ---------- 9. Способ В: ответ письмом ----------
  console.log("\n--- способ В: ответ подписанта письмом ---");
  const res2 = await sess.secretary.post("/api/docflow/resolutions", {
    ...resBody,
    text: "Проверка способа В: утверждение ответом письмом."
  });
  const rid2 = res2.body?.id;
  await sess.secretary.post("/api/docflow/resolutions/" + rid2 + "/request-approval");
  expect("подписант НЕ подтверждает сам себя", await sess.signer.post("/api/docflow/resolutions/" + rid2 + "/confirm", { approvedBy: null }), [403]);
  expect("аппарат фиксирует ответ письмом", await sess.secretary.post("/api/docflow/resolutions/" + rid2 + "/email-approval", {
    emailId: "e2e-reply-" + Date.now(),
    replyText: "Утверждаю"
  }), [200]);
  expect("из «ждёт подтверждения» отправлять нельзя", await sess.secretary.post("/api/docflow/resolutions/" + rid2 + "/dispatch"), [409]);
  const confirmed = await sess.secretary.post("/api/docflow/resolutions/" + rid2 + "/confirm", {
    approvedBy: byLogin(ACCOUNTS.signer.login)?.id ?? null
  });
  expect("аппарат подтверждает разбор", confirmed, [200]);
  check("способ утверждения — письмо", confirmed.body?.approvalMethod === "email", confirmed.body?.approvalMethod);
  check("подтвердил аппарат, а не подписант", confirmed.body?.confirmedBy !== confirmed.body?.approvedBy);
  expect("после подтверждения можно отправлять", await sess.secretary.post("/api/docflow/resolutions/" + rid2 + "/dispatch"), [200]);

// ---------- 10. Реальный пайплайн: письмо от внешнего -> руководитель -> исполнитель ----------
  console.log("\n--- пайплайн: аппарат направляет письмо руководителю ---");

  const reg2 = await sess.secretary.post("/api/docflow/journal", {
    summary: "Внешнее письмо для пайплайна " + stamp,
    sender: "ООО «Внешний партнёр»"
  });
  check("внешнее письмо зарегистрировано", reg2.status === 201, "статус " + reg2.status + " " + JSON.stringify(reg2.body).slice(0, 80));
  const doc2 = reg2.body?.id;

  expect("руководитель НЕ направляет письмо себе", await sess.manager.post("/api/docflow/resolutions/forward", { documentId: doc2 }), [403]);
  expect("подписант НЕ направляет письмо", await sess.signer.post("/api/docflow/resolutions/forward", { documentId: doc2 }), [403]);

  const managerId = byLogin(ACCOUNTS.manager.login).id;
  expect("без получателя письмо не уходит", await sess.secretary.post("/api/docflow/resolutions/forward", { documentId: doc2 }), [400]);
  const fwd = await sess.secretary.post("/api/docflow/resolutions/forward", { documentId: doc2, toUserId: managerId });
  expect("аппарат направляет письмо руководителю", fwd, [201]);
  // Проверяем, что письмо действительно ушло, а не только запись создана.
  check("письмо отправлено по адресу руководителя", !!fwd.body?.sentTo, String(fwd.body?.sentTo));
  check("сохранена ссылка на отправленное письмо", !!fwd.body?.sentEmailId, String(fwd.body?.sentEmailId));
  check("письмо привязано к записи", !!fwd.body?.requestEmailId, String(fwd.body?.requestEmailId));
  const fid = fwd.body?.id;
  check("резолюции ещё нет — текст пуст", fwd.body?.text === "", JSON.stringify(fwd.body?.text));
  check("исполнителей нет — решает руководитель", (fwd.body?.assignees ?? []).length === 0);
  check("состояние — на утверждении у руководителя", fwd.body?.status === "pending_approval", fwd.body?.status);

  expect("повторно направить нельзя", await sess.secretary.post("/api/docflow/resolutions/forward", { documentId: doc2, toUserId: managerId }), [409]);

  // Руководитель видит письмо в своей очереди и сам пишет резолюцию.
  const mgrQueue = await sess.manager.get("/api/docflow/resolutions/for-approval");
  check("письмо попало в очередь руководителя", (mgrQueue.body?.items ?? []).some((x) => x.id === fid));

  console.log("\n--- пайплайн: руководитель пишет резолюцию и назначает исполнителя ---");
  const execId = byLogin(ACCOUNTS.executor.login).id;
  // 400, а не 409: состояние верное («утверждено»), но отправлять нечего — руководитель
  // не написал текст. Это не конфликт состояний, а неполные данные.
  expect("пустую резолюцию отправить нельзя", await sess.secretary.post("/api/docflow/resolutions/" + fid + "/dispatch"), [400]);

  const mgrApprove = await sess.manager.post("/api/docflow/resolutions/" + fid + "/approve", {
    text: "Петровой М.А. подготовить ответ внешнему партнёру.",
    assignees: [{ userId: execId, kind: "responsible" }],
    priority: "urgent",
    deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  });
  expect("руководитель утверждает со своим текстом", mgrApprove, [200]);
  check("в резолюции текст руководителя", (mgrApprove.body?.text ?? "").includes("Петровой"), mgrApprove.body?.text);
  check("автор резолюции — руководитель", mgrApprove.body?.approvedBy === byLogin(ACCOUNTS.manager.login).id);

  const fwdCard = await sess.secretary.get("/api/docflow/resolutions/" + fid);
  check("исполнитель назначен руководителем", (fwdCard.body?.assignees ?? []).some((a) => a.userId === execId && a.kind === "responsible"));
  check("подготовил аппарат, утвердил руководитель — разные люди",
    fwdCard.body?.preparedByName !== fwdCard.body?.approvedByName,
    fwdCard.body?.preparedByName + " / " + fwdCard.body?.approvedByName);

  expect("аппарат отправляет исполнителю", await sess.secretary.post("/api/docflow/resolutions/" + fid + "/dispatch"), [200]);
  const finalTasks = await sess.executor.get("/api/docflow/resolutions/my-tasks");
  const finalTask = (finalTasks.body ?? []).find((t) => t.resolutionId === fid);
  check("задача дошла до исполнителя", !!finalTask);
  check("в задаче текст руководителя", (finalTask?.text ?? "").includes("Петровой"), finalTask?.text);
  check("исполнитель — ответственный", finalTask?.kind === "responsible", finalTask?.kind);

  // ---------- Итог ----------
  console.log("\n=== Итог: " + passed + " успешно, " + failed + " провалено ===");
  if (failed) {
    console.log("\nПровалы:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Ошибка сценария:", e);
  process.exit(1);
});