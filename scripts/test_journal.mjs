
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
 * Сквозной тест журнала регистрации (СЭД, этап 2).
 *
 * Повторяет приёмку этапа: регистрирую письмо из ящика → появляется запись
 * с автономером → вижу её в журнале → выгружаю в Excel.
 *
 * Требуется запущенный сервер с DOCFLOW_DATABASE_URL и MAILSENSE_ADMIN_LOGINS.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8123";
const LOGIN = process.env.ADMIN_LOGIN ?? "test@stand.test";
const PASSWORD = process.env.ADMIN_PASSWORD ?? standPass("STAND_ADMIN_PASS");

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

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(options.headers ?? {}) }
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function json(path, options) {
  const res = await api(path, options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log("=== Журнал регистрации: сквозной сценарий ===");

  // 1. Вход администратора
  const login = await json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ login: LOGIN, password: PASSWORD })
  });
  check("вход администратора", login.status === 200, "статус " + login.status);
  if (login.status !== 200) {
    console.log("Дальше идти нельзя: нет сессии.");
    process.exit(1);
  }

  // 2. «Входящие на регистрацию» — письма, ещё не ставшие документами
  const incoming = await json("/api/docflow/journal/incoming");
  check("раздел «Входящие на регистрацию» отвечает", incoming.status === 200);
  const items = incoming.body?.items ?? [];
  check("в списке есть письма", items.length > 0, "писем: " + items.length);
  if (!items.length) {
    console.log("Нет писем для регистрации — проверьте, что ящик просканирован.");
    process.exit(1);
  }

  const email = items[0];
  console.log("     письмо: " + email.subject.slice(0, 60));

  // 3. Подсказки для формы
  const suggest = await json("/api/docflow/journal/suggest?emailId=" + encodeURIComponent(email.emailId));
  check("подсказки формы отвечают", suggest.status === 200);
  check("отправитель подставлен", !!suggest.body?.sender, JSON.stringify(suggest.body?.sender));
  check("содержание подставлено", !!suggest.body?.summary);
  check("письмо ещё не зарегистрировано", suggest.body?.alreadyRegistered === null);

  // 4. Дублей до регистрации быть не должно
  const dupBefore = await json("/api/docflow/journal/duplicates?emailId=" + encodeURIComponent(email.emailId));
  check("до регистрации дублей нет", Array.isArray(dupBefore.body) && dupBefore.body.length === 0);

  // 5. Регистрация
  const created = await json("/api/docflow/journal", {
    method: "POST",
    body: JSON.stringify({
      emailId: email.emailId,
      sender: suggest.body.sender,
      summary: suggest.body.summary || email.subject,
      docNumber: suggest.body.docNumber,
      docDate: suggest.body.docDate || null,
      sheetsCount: suggest.body.sheetsCount,
      documentName: suggest.body.documentName
    })
  });
  check("документ зарегистрирован", created.status === 201, "статус " + created.status + " " + JSON.stringify(created.body).slice(0, 160));
  const doc = created.body;
  check("присвоен автоматический номер", /^вх\d+$/.test(String(doc?.regNumber ?? "")), String(doc?.regNumber));
  console.log("     номер: " + doc.regNumber + ", дата: " + doc.regDate);

  // 6. Журнал
  const list = await json("/api/docflow/journal?limit=100");
  check("журнал отвечает", list.status === 200);
  check("запись видна в журнале", (list.body?.items ?? []).some((d) => d.id === doc.id));
  check("общее количество посчитано", typeof list.body?.total === "number" && list.body.total > 0);

  // 7. Поиск по журналу
  const search = await json("/api/docflow/journal?search=" + encodeURIComponent(doc.regNumber));
  check("поиск по номеру находит запись", (search.body?.items ?? []).some((d) => d.id === doc.id));

  // 8. Повторная регистрация того же письма
  const again = await json("/api/docflow/journal", {
    method: "POST",
    body: JSON.stringify({ emailId: email.emailId, summary: "Повтор" })
  });
  check("повторная регистрация отклонена", again.status === 409, "статус " + again.status);

  const dupAfter = await json("/api/docflow/journal/duplicates?emailId=" + encodeURIComponent(email.emailId));
  check("дубль находится по письму", (dupAfter.body ?? []).some((d) => d.reason === "email"));

  // 9. Карточка и правка
  const card = await json("/api/docflow/journal/" + doc.id);
  check("карточка открывается", card.status === 200 && card.body?.id === doc.id);
  check("письмо связано с документом", (card.body?.emails ?? []).some((e) => e.emailId === email.emailId));

  const patched = await json("/api/docflow/journal/" + doc.id, {
    method: "PATCH",
    body: JSON.stringify({ sheetsCount: 7, caseNumber: "01-15" })
  });
  check("правка сохранена", patched.body?.sheetsCount === 7 && patched.body?.caseNumber === "01-15");
  check("номер при правке не изменился", patched.body?.regNumber === doc.regNumber);

  // 10. Выгрузка в Excel
  const xlsx = await api("/api/docflow/journal/export");
  const buf = Buffer.from(await xlsx.arrayBuffer());
  check("выгрузка отвечает", xlsx.status === 200, "статус " + xlsx.status);
  check("это действительно xlsx (zip-контейнер)", buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4b);
  check("имя файла задано", (xlsx.headers.get("content-disposition") ?? "").includes(".xlsx"));
  console.log("     размер файла: " + buf.length + " байт");

  // 11. Нумерация
  const numbering = await json("/api/docflow/numbering");
  check("состояние нумерации отвечает", numbering.status === 200);
  check("правило «вх» на месте", (numbering.body?.rules ?? []).some((r) => r.stream === "incoming" && r.prefix === "вх"));
  check("открытый период известен", !!numbering.body?.openPeriod, String(numbering.body?.openPeriod));

  // 12. Прослеживаемость: кто зарегистрировал и кто правил
  const auditReg = await json(
    "/api/audit?entityType=document&entityId=" + encodeURIComponent(doc.id) + "&action=journal.register"
  );
  check("регистрация попала в аудит", auditReg.status === 200 && (auditReg.body?.entries ?? []).length === 1);
  const regEntry = (auditReg.body?.entries ?? [])[0];
  check("в аудите записано, КТО зарегистрировал", !!regEntry?.userName, JSON.stringify(regEntry?.userName));
  check("в аудите есть номер документа", String(regEntry?.newValue ?? "").includes(doc.regNumber));
  console.log("     зарегистрировал: " + regEntry?.userName);

  const auditEdit = await json(
    "/api/audit?entityType=document&entityId=" + encodeURIComponent(doc.id) + "&action=journal.edit"
  );
  const editEntry = (auditEdit.body?.entries ?? [])[0];
  check("правка попала в аудит", !!editEntry);
  check(
    "видно, ЧТО было и что стало",
    String(editEntry?.oldValue ?? "").includes("sheetsCount") && String(editEntry?.newValue ?? "").includes("7"),
    String(editEntry?.oldValue ?? "").slice(0, 80)
  );

  const auditDenied = await json("/api/audit?action=journal.register_denied");
  check(
    "неудачная повторная регистрация тоже зафиксирована",
    (auditDenied.body?.entries ?? []).some((e) => String(e.newValue ?? "").includes("duplicate_email"))
  );

  const auditList = await json("/api/audit?limit=5");
  check("аудит отдаёт общее количество", typeof auditList.body?.total === "number" && auditList.body.total > 0);

  const auditXlsx = await api("/api/audit/export");
  const auditBuf = Buffer.from(await auditXlsx.arrayBuffer());
  check("выгрузка аудита в Excel", auditBuf.length > 100 && auditBuf[0] === 0x50 && auditBuf[1] === 0x4b);

  // 13. Письмо больше не предлагается к регистрации
  const incomingAfter = await json("/api/docflow/journal/incoming");
  check(
    "зарегистрированное письмо ушло из «на регистрацию»",
    !(incomingAfter.body?.items ?? []).some((e) => e.emailId === email.emailId)
  );

  console.log("");
  console.log("Пройдено: " + passed + ", провалено: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Ошибка сценария:", err.message);
  process.exit(1);
});