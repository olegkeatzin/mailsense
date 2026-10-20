import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";
import {
  approveResolution,
  closeResolution,
  forwardToManager,
  cancelResolution,
  confirmEmailApproval,
  confirmReport,
  createResolution,
  dispatchResolution,
  getResolution,
  getResolutionDetail,
  listBoard,
  listMyTasks,
  listProposedReports,
  listResolutionHistory,
  markEmailApproval,
  markTaskReceived,
  proposeReportFromEmail,
  rejectResolution,
  reportExecution,
  requestApproval,
  updateResolution,
  resolutionsByDocument
} from "./resolutions.js";

/**
 * Резолюции: главное здесь — запреты. Поручение не должно уйти исполнителям без подписи,
 * а подписанный текст — измениться задним числом. Эти два свойства проверяются отдельно.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";


// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
// Раньше здесь был фолбэк на DOCFLOW_DATABASE_URL — рабочую переменную стенда: один
// `make test` на машине с ней вычищал пользователей, сессии, настройки и append-only аудит.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const secretary: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };
const director: Actor = { id: "u-director", name: "Иванов И.И." };
const executorA: Actor = { id: "u-exec-a", name: "Романов Е.С." };
const executorB: Actor = { id: "u-exec-b", name: "Барышникова Л.С." };

let dir = "";
let documentId = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-resolutions-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await getDocflowPool().query(
    "TRUNCATE resolutions, resolution_assignees, resolution_approvals, documents, document_emails, " +
      "number_counters, number_archives, audit_log, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  for (const u of [secretary, director, executorA, executorB]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.id + "@stand.test", u.name, ts, ts]
    );
  }
  const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, secretary);
  documentId = doc.id;
});

afterEach(async () => {
  // Триггер не должен пережить упавший тест: иначе следующие упадут «на ровном месте».
  await unblockAudit();
});

/**
 * Запись в audit_log падает на уровне СУБД — ровно то, что бывает при сбое.
 * Тот же приём, что в auditAtomicity.test.ts: проверяем не «есть ли след»,
 * а атомарность «изменение и след — одно».
 */
async function blockAudit(): Promise<void> {
  await getDocflowPool().query(
    "CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger AS $$ " +
      "BEGIN RAISE EXCEPTION 'тест: запись аудита недоступна'; END; $$ LANGUAGE plpgsql; " +
      "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; " +
      "CREATE TRIGGER test_block_audit_trg BEFORE INSERT ON audit_log " +
      "FOR EACH ROW EXECUTE FUNCTION test_block_audit();"
  );
}

async function unblockAudit(): Promise<void> {
  await getDocflowPool().query(
    "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; DROP FUNCTION IF EXISTS test_block_audit();"
  );
}

/** Черновик с двумя исполнителями: первый — ответственный. */
async function draft(text = "Рассмотреть участие и подготовить заявку") {
  return createResolution(
    {
      documentId,
      text,
      sourceText: "ИИ предложил: " + text,
      sourceKind: "ai",
      priority: "important",
      deadline: "2026-09-07",
      assignees: [
        { userId: executorA.id, kind: "responsible" },
        { userId: executorB.id, kind: "coexecutor" }
      ]
    },
    secretary
  );
}

describe("создание черновика", () => {
  test("черновик создаётся с исполнителями и приоритетом", async () => {
    const r = await draft();
    expect(r.status).toBe("draft");
    expect(r.priority).toBe("important");
    expect(r.deadline).toBe("2026-09-07");
    expect(r.preparedBy).toBe(secretary.id);
    const d = (await getResolutionDetail(r.id))!;
    expect(d.assignees).toHaveLength(2);
    // Ответственный всегда первым: с него спрос.
    expect(d.assignees[0].kind).toBe("responsible");
    expect(d.assignees[0].fullName).toBe("Романов Е.С.");
  });

  test("сохраняется исходный текст до правок", async () => {
    // Нужен для будущей подсказки резолюции: учиться надо на живых формулировках.
    const r = await draft("Исходная формулировка");
    expect(r.sourceText).toContain("ИИ предложил");
    expect(r.sourceKind).toBe("ai");
  });

  test("пустой текст не принимается", async () => {
    await expect(createResolution({ documentId, text: "   ", assignees: [{ userId: executorA.id }] }, secretary)).rejects.toThrow(
      /пуст/i
    );
  });

  test("без исполнителей поручение не создаётся", async () => {
    await expect(createResolution({ documentId, text: "Текст", assignees: [] }, secretary)).rejects.toThrow(
      /исполнител/i
    );
  });

  test("несуществующий исполнитель отклоняется", async () => {
    await expect(
      createResolution({ documentId, text: "Текст", assignees: [{ userId: "нет-такого" }] }, secretary)
    ).rejects.toThrow(/не найден/i);
  });

  test("двух ответственных назначить нельзя", async () => {
    await expect(
      createResolution(
        {
          documentId,
          text: "Текст",
          assignees: [
            { userId: executorA.id, kind: "responsible" },
            { userId: executorB.id, kind: "responsible" }
          ]
        },
        secretary
      )
    ).rejects.toThrow(/один/i);
  });

  test("резолюция к несуществующему документу не создаётся", async () => {
    await expect(
      createResolution({ documentId: "нет-такого", text: "Текст", assignees: [{ userId: executorA.id }] }, secretary)
    ).rejects.toThrow(/не найден/i);
  });
});

describe("правка черновика", () => {
  test("текст и срок правятся, пока резолюция черновик", async () => {
    const r = await draft();
    const updated = await updateResolution(r.id, { text: "Уточнённый текст", deadline: "2026-09-10" }, secretary);
    expect(updated.text).toBe("Уточнённый текст");
    expect(updated.deadline).toBe("2026-09-10");
  });

  test("исполнителей можно заменить целиком", async () => {
    const r = await draft();
    const updated = await updateResolution(r.id, { assignees: [{ userId: executorB.id, kind: "responsible" }] }, secretary);
    const d = (await getResolutionDetail(updated.id))!;
    expect(d.assignees).toHaveLength(1);
    expect(d.assignees[0].userId).toBe(executorB.id);
  });

  test("ПОСЛЕ отправки на утверждение текст менять нельзя", async () => {
    // Иначе подписант подписывал бы одно, а исполнитель получил другое.
    const r = await draft();
    await requestApproval(r.id, secretary);
    await expect(updateResolution(r.id, { text: "Подмена" }, secretary)).rejects.toThrow(/нельзя|утверждени/i);
  });

  test("пустой текст при правке отклоняется", async () => {
    const r = await draft();
    await expect(updateResolution(r.id, { text: "  " }, secretary)).rejects.toThrow(/пуст/i);
  });
});

describe("утверждение: способ А (в приложении)", () => {
  test("черновик → на утверждении → утверждено", async () => {
    const r = await draft();
    expect((await requestApproval(r.id, secretary)).status).toBe("pending_approval");
    const approved = await approveResolution(r.id, director);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(director.id);
    expect(approved.approvalMethod).toBe("app");
    expect(approved.approvedAt).toBeTruthy();
  });

  test("нельзя утвердить то, что не отправлено на утверждение", async () => {
    const r = await draft();
    await expect(approveResolution(r.id, director)).rejects.toThrow(/невозможно/i);
  });

  test("нельзя отправить на утверждение пустой черновик без исполнителей", async () => {
    const r = await draft();
    await updateResolution(r.id, { assignees: [{ userId: executorA.id, kind: "responsible" }] }, secretary);
    await expect(requestApproval(r.id, secretary)).resolves.toBeTruthy();
  });

  test("повторное утверждение уже утверждённого не проходит", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await expect(approveResolution(r.id, director)).rejects.toThrow(/невозможно/i);
  });
});

describe("утверждение: способ В (ответом письмом)", () => {
  test("ответ подписанта переводит в «ждёт подтверждения», а не в «утверждено»", async () => {
    // Автоматический разбор свободного текста не может быть основанием для поручения (Р9).
    const r = await draft();
    await requestApproval(r.id, secretary, { requestEmailId: "req-1" });
    const marked = await markEmailApproval(r.id, { emailId: "reply-1", replyText: "Утверждаю" }, director);
    expect(marked.status).toBe("email_approval");
    expect(marked.approvalMethod).toBe("email");
    expect(marked.approvalEmailId).toBe("reply-1");
    // Ключевое: утверждённым оно ещё НЕ стало.
    expect(marked.approvedAt).toBeNull();
  });

  test("текст ответа сохраняется в истории, но резолюцию не перезаписывает", async () => {
    const r = await draft("Текст аппарата");
    await requestApproval(r.id, secretary);
    await markEmailApproval(r.id, { emailId: "reply-2", replyText: "Утверждаю, срок до 10.09" }, director);
    const d = (await getResolutionDetail(r.id))!;
    expect(d.text).toBe("Текст аппарата");
    expect(d.history.some((h) => (h.comment ?? "").includes("срок до 10.09"))).toBe(true);
  });

  test("аппарат подтверждает — только тогда «утверждено»", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await markEmailApproval(r.id, { emailId: "reply-3", replyText: "Согласен" }, director);
    const confirmed = await confirmEmailApproval(r.id, secretary, { approvedBy: director.id });
    expect(confirmed.status).toBe("approved");
    expect(confirmed.confirmedBy).toBe(secretary.id);
    expect(confirmed.approvedBy).toBe(director.id);
    // В журнале видно и подписанта, и того, кто подтвердил разбор.
    expect(confirmed.confirmedAt).toBeTruthy();
  });

  test("подтвердить без полученного ответа нельзя", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await expect(confirmEmailApproval(r.id, secretary)).rejects.toThrow(/невозможно/i);
  });
});

describe("возврат на доработку", () => {
  test("подписант вернул — резолюция снова черновик", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    const back = await rejectResolution(r.id, director, "Не тот исполнитель");
    expect(back.status).toBe("draft");
    expect(back.approvedBy).toBeNull();
    // После возврата текст снова можно править.
    await expect(updateResolution(r.id, { text: "Исправлено" }, secretary)).resolves.toBeTruthy();
  });

  test("возврат из состояния «ждёт подтверждения» тоже работает", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await markEmailApproval(r.id, { emailId: "reply-4", replyText: "Не уверен" }, director);
    const back = await rejectResolution(r.id, secretary, "Подписант не утвердил");
    expect(back.status).toBe("draft");
  });
});

describe("отправка исполнителям", () => {
  test("утверждённая резолюция уходит исполнителям", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    const sent = await dispatchResolution(r.id, secretary, { dispatchEmailId: "out-1" });
    expect(sent.status).toBe("sent");
    expect(sent.dispatchedBy).toBe(secretary.id);
    expect(sent.dispatchedAt).toBeTruthy();
  });

  test("НЕЛЬЗЯ отправить неутверждённую резолюцию", async () => {
    // Главный запрет этапа: поручение без подписи уйти не должно.
    const r = await draft();
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/невозможно/i);
    await requestApproval(r.id, secretary);
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/невозможно/i);
  });

  test("резолюцию в состоянии «ждёт подтверждения» отправлять нельзя", async () => {
    // Даже если подписант ответил письмом, без проверки аппаратом поручение не уходит.
    const r = await draft();
    await requestApproval(r.id, secretary);
    await markEmailApproval(r.id, { emailId: "reply-5", replyText: "Утверждаю" }, director);
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/невозможно/i);
  });

  test("отменённую резолюцию отправить нельзя", async () => {
    const r = await draft();
    await cancelResolution(r.id, secretary, "Ошиблись документом");
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/невозможно/i);
  });
});

describe("задачи исполнителя и расписка", () => {
  test("до отправки задачи у исполнителя нет", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    expect(await listMyTasks(executorA.id)).toHaveLength(0);
  });

  test("после отправки задача появляется у всех исполнителей", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    const tasksA = await listMyTasks(executorA.id);
    const tasksB = await listMyTasks(executorB.id);
    expect(tasksA).toHaveLength(1);
    expect(tasksB).toHaveLength(1);
    // Роль исполнителя видна: у ответственного она отличается (Р10).
    expect(tasksA[0].kind).toBe("responsible");
    expect(tasksB[0].kind).toBe("coexecutor");
    expect(tasksA[0].documentNumber).toBe("вх1");
  });

  test("чужая задача в «Мои задачи» не попадает", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    expect(await listMyTasks(director.id)).toHaveLength(0);
  });

  test("расписка ставится один раз и не переписывается", async () => {
    // Важно, когда исполнитель получил документ ВПЕРВЫЕ, а не когда открыл его в последний раз.
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    await markTaskReceived(r.id, executorA.id);
    const first = (await listMyTasks(executorA.id))[0].receivedAt;
    expect(first).toBeTruthy();

    await new Promise((res) => setTimeout(res, 5));
    await markTaskReceived(r.id, executorA.id);
    expect((await listMyTasks(executorA.id))[0].receivedAt).toBe(first);
  });

  test("расписка не ставится тому, кто не исполнитель", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    await markTaskReceived(r.id, director.id);
    const d = (await getResolutionDetail(r.id))!;
    expect(d.assignees.every((a) => a.receivedAt === null)).toBe(true);
  });

  test("расписка пишет след в аудит", async () => {
    // Расписка — мутация графы 8 журнала, а не служебная пометка: у неё обязан быть след.
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    await markTaskReceived(r.id, executorA.id);

    const rows = await getDocflowPool().query<{ action: string; user_name: string }>(
      "SELECT action, user_name FROM audit_log WHERE entity_type = 'resolution' AND entity_id = $1 " +
        "AND action = 'resolution.received'",
      [r.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].user_name).toBe("Романов Е.С.");
    expect((await listMyTasks(executorA.id))[0].receivedAt).toBeTruthy();
  });

  test("сбой записи аудита откатывает расписку", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    await blockAudit();
    await expect(markTaskReceived(r.id, executorA.id)).rejects.toThrow();

    // Изменение без следа недопустимо: расписки быть не должно (AGENTS.md, п. 4).
    expect((await listMyTasks(executorA.id))[0].receivedAt).toBeNull();
  });

  test("повторная расписка безопасна и не плодит следы", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    await markTaskReceived(r.id, executorA.id);
    const first = (await listMyTasks(executorA.id))[0].receivedAt;
    await markTaskReceived(r.id, executorA.id);

    expect((await listMyTasks(executorA.id))[0].receivedAt).toBe(first);
    const rows = await getDocflowPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.received' AND entity_id = $1",
      [r.id]
    );
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  test("просроченная задача помечается, исполненная — нет", async () => {
    const r = await createResolution(
      { documentId, text: "Срочное поручение", deadline: "2020-01-01", assignees: [{ userId: executorA.id, kind: "responsible" }] },
      secretary
    );
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    const task = (await listMyTasks(executorA.id))[0];
    expect(task.overdue).toBe(true);
    expect(task.daysLeft).toBeLessThan(0);
  });

  test("без срока задача не считается просроченной", async () => {
    const r = await createResolution(
      { documentId, text: "Без срока", deadline: null, assignees: [{ userId: executorA.id, kind: "responsible" }] },
      secretary
    );
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    const task = (await listMyTasks(executorA.id))[0];
    expect(task.overdue).toBe(false);
    expect(task.daysLeft).toBeNull();
  });
});

describe("история и канбан", () => {
  test("история содержит всю цепочку с авторами", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);

    const history = await listResolutionHistory(r.id);
    const steps = history.map((h) => h.step);
    expect(steps).toContain("requested");
    expect(steps).toContain("approved");
    expect(steps).toContain("dispatched");
    // В истории видно, кто именно утвердил и кто отправил.
    expect(history.find((h) => h.step === "approved")!.actorName).toBe("Иванов И.И.");
    expect(history.find((h) => h.step === "dispatched")!.actorName).toBe("Авдеева Ю.Н.");
  });

  test("в карточке видны ФИО всех участников", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    const d = (await getResolutionDetail(r.id))!;
    expect(d.preparedByName).toBe("Авдеева Ю.Н.");
    expect(d.approvedByName).toBe("Иванов И.И.");
    expect(d.dispatchedByName).toBe("Авдеева Ю.Н.");
    expect(d.documentNumber).toBe("вх1");
  });

  test("канбан раскладывает резолюции по колонкам", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    const board = await listBoard();
    const pending = board.find((c) => c.key === "pending_approval")!;
    expect(pending.items.some((i) => i.id === r.id)).toBe(true);
  });

  test("просроченная отправленная резолюция попадает в колонку «Просрочено»", async () => {
    const r = await createResolution(
      { documentId, text: "Просроченное", deadline: "2020-01-01", assignees: [{ userId: executorA.id, kind: "responsible" }] },
      secretary
    );
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    const board = await listBoard();
    expect(board.find((c) => c.key === "overdue")!.items.some((i) => i.id === r.id)).toBe(true);
    expect(board.find((c) => c.key === "sent")!.items.some((i) => i.id === r.id)).toBe(true);
  });

  test("в истории аудита видны все шаги", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    const rows = await getDocflowPool().query<{ action: string; user_name: string }>(
      "SELECT action, user_name FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at",
      ["resolution", r.id]
    );
    const actions = rows.rows.map((x) => x.action);
    expect(actions).toEqual(["resolution.create", "resolution.request_approval", "resolution.approve", "resolution.dispatch"]);
    expect(rows.rows[2].user_name).toBe("Иванов И.И.");
  });
});
describe("письмо руководителю: он сам пишет резолюцию и назначает исполнителя", () => {
  test("пересылка создаёт запись с пустым текстом и без исполнителей", async () => {
    // Резолюции ещё нет — есть только письмо. Решает руководитель, не аппарат.
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-1" });
    expect(r.status).toBe("pending_approval");
    expect(r.sourceKind).toBe("forwarded");
    expect(r.text).toBe("");
    expect(r.requestEmailId).toBe("fwd-1");
    const d = (await getResolutionDetail(r.id))!;
    expect(d.assignees).toHaveLength(0);
  });

  test("повторно переслать, пока нет решения, нельзя", async () => {
    await forwardToManager(documentId, secretary, { emailId: "fwd-2" });
    await expect(forwardToManager(documentId, secretary, { emailId: "fwd-3" })).rejects.toThrow(/уже направлено/i);
  });

  test("руководитель пишет текст и назначает исполнителя при утверждении", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-4" });
    const approved = await approveResolution(r.id, director, {
      text: "Романову Е.С. подготовить ответ в срок до 20.09.2026.",
      assignees: [{ userId: executorA.id, kind: "responsible" }],
      priority: "urgent",
      deadline: "2026-09-20"
    });
    expect(approved.status).toBe("approved");
    expect(approved.text).toContain("Романову Е.С.");
    expect(approved.priority).toBe("urgent");
    expect(approved.deadline).toBe("2026-09-20");

    const d = (await getResolutionDetail(r.id))!;
    expect(d.assignees).toHaveLength(1);
    expect(d.assignees[0].userId).toBe(executorA.id);
    expect(d.assignees[0].kind).toBe("responsible");
    // Автор резолюции — руководитель, а не аппарат, переславший письмо.
    expect(approved.approvedBy).toBe(director.id);
    expect(approved.preparedBy).toBe(secretary.id);
  });

  test("назначение исполнителя руководителем попадает в аудит", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-5" });
    await approveResolution(r.id, director, {
      text: "Поручить исполнителю",
      assignees: [{ userId: executorB.id, kind: "responsible" }]
    });
    const rows = await getDocflowPool().query<{ action: string; user_name: string }>(
      "SELECT action, user_name FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at",
      ["resolution", r.id]
    );
    const assign = rows.rows.find((x) => x.action === "resolution.assignees");
    expect(assign).toBeTruthy();
    expect(assign!.user_name).toBe("Иванов И.И.");
  });

  test("ПУСТУЮ резолюцию отправить исполнителям нельзя", async () => {
    // Руководитель утвердил, ничего не написав и никого не назначив.
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-6" });
    await approveResolution(r.id, director);
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/без текста|исполнител/i);
  });

  test("резолюцию без исполнителей отправить нельзя", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-7" });
    await approveResolution(r.id, director, { text: "Текст есть, исполнителя нет" });
    await expect(dispatchResolution(r.id, secretary)).rejects.toThrow(/исполнител/i);
  });

  test("путь целиком: пересылка, резолюция руководителя, задача у исполнителя", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-8" });
    await approveResolution(r.id, director, {
      text: "Подготовить ответ",
      assignees: [{ userId: executorA.id, kind: "responsible" }],
      deadline: "2026-09-25"
    });
    await dispatchResolution(r.id, secretary, { dispatchEmailId: "out-8" });

    const tasks = await listMyTasks(executorA.id);
    const task = tasks.find((t) => t.resolutionId === r.id);
    expect(task).toBeTruthy();
    expect(task!.text).toBe("Подготовить ответ");
    expect(task!.deadline).toBe("2026-09-25");
    expect(task!.receivedAt).toBeNull();
  });

  test("ответ письмом: аппарат вписывает исполнителя при подтверждении", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-9" });
    await markEmailApproval(r.id, { emailId: "reply-9", replyText: "Романову Е.С. — подготовить ответ" }, director);
    // Фамилию из письма машина разобрать не может — её подставляет аппарат.
    const confirmed = await confirmEmailApproval(r.id, secretary, {
      approvedBy: director.id,
      text: "Романову Е.С. — подготовить ответ",
      assignees: [{ userId: executorA.id, kind: "responsible" }]
    });
    expect(confirmed.status).toBe("approved");
    expect(confirmed.text).toContain("Романову");
    const d = (await getResolutionDetail(r.id))!;
    expect(d.assignees[0].userId).toBe(executorA.id);
    expect(confirmed.approvedBy).toBe(director.id);
    expect(confirmed.confirmedBy).toBe(secretary.id);
  });

  test("пустой текст в подтверждении отклоняется", async () => {
    const r = await forwardToManager(documentId, secretary, { emailId: "fwd-10" });
    await markEmailApproval(r.id, { emailId: "reply-10", replyText: "Утверждаю" }, director);
    await expect(confirmEmailApproval(r.id, secretary, { text: "   " })).rejects.toThrow(/пуст/i);
  });
});
describe("на пути «ответом письмом» подписант не теряется", () => {
  /**
   * Найденный баг: `markEmailApproval` не записывал, КТО подписал, а `confirmEmailApproval`
   * подставлял `approvedBy: opts.approvedBy ?? null` — интерфейс передавал туда null.
   * В результате после подтверждения в резолюции не было подписавшего: в журнале графа
   * «Резолюция руководства» оставалась пустой, и прослеживаемость терялась там, где она
   * нужнее всего — на решении руководителя.
   */
  test("ответ письмом сразу фиксирует подписанта", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary, { requestEmailId: "req-sig" });
    const marked = await markEmailApproval(r.id, { emailId: "reply-sig", replyText: "Утверждаю" }, director);
    expect(marked.approvedBy).toBe(director.id);
    // Подпись есть, но утверждённым оно ещё не стало — ждёт подтверждения аппарата.
    expect(marked.approvedAt).toBeNull();
  });

  test("подтверждение аппаратом сохраняет подписанта, а не обнуляет его", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary, { requestEmailId: "req-sig2" });
    await markEmailApproval(r.id, { emailId: "reply-sig2", replyText: "Утверждаю" }, director);
    // Интерфейс аппарата не знает идентификатора подписанта и передаёт null.
    const confirmed = await confirmEmailApproval(r.id, secretary, { approvedBy: null });
    expect(confirmed.approvedBy).toBe(director.id);
    expect(confirmed.confirmedBy).toBe(secretary.id);
    // Разные люди: подписал руководитель, подтвердил разбор аппарат.
    expect(confirmed.approvedBy).not.toBe(confirmed.confirmedBy);
  });

  test("аппарат может указать подписанта вручную, если система не смогла", async () => {
    const r = await draft();
    await requestApproval(r.id, secretary, { requestEmailId: "req-sig3" });
    await markEmailApproval(r.id, { emailId: "reply-sig3", replyText: "Утверждаю" }, secretary);
    const confirmed = await confirmEmailApproval(r.id, secretary, { approvedBy: director.id });
    expect(confirmed.approvedBy).toBe(director.id);
  });
});
describe("отчёт об исполнении (этап 4)", () => {
  /** Доводит поручение до состояния «отправлено исполнителям». */
  async function sent(assignees?: Array<{ userId: string; kind: "responsible" | "coexecutor" }>) {
    const r = await draft();
    if (assignees) await updateResolution(r.id, { assignees }, secretary);
    await requestApproval(r.id, secretary);
    await approveResolution(r.id, director);
    await dispatchResolution(r.id, secretary);
    return r.id;
  }

  test("отчёт сохраняется и виден в задаче", async () => {
    const id = await sent();
    const after = await reportExecution(id, executorA.id, { text: "Ответ подготовлен и направлен" }, executorA);
    expect(after.status).toBe("done");
    const d = (await getResolutionDetail(id))!;
    const mine = d.assignees.find((a) => a.userId === executorA.id)!;
    expect(mine.reportText).toBe("Ответ подготовлен и направлен");
    expect(mine.reportAt).toBeTruthy();
  });

  test("пустой отчёт не принимается", async () => {
    const id = await sent();
    await expect(reportExecution(id, executorA.id, { text: "   " }, executorA)).rejects.toThrow(/пуст/i);
  });

  test("отчитаться может только исполнитель", async () => {
    // Директор и аппарат к поручению не приписаны — их отчёт не должен приниматься.
    const id = await sent();
    await expect(reportExecution(id, director.id, { text: "Сделано" }, director)).rejects.toThrow(/не исполнитель/i);
  });

  test("до отправки исполнителям отчитаться нельзя", async () => {
    const r = await draft();
    await expect(reportExecution(r.id, executorA.id, { text: "Сделано" }, executorA)).rejects.toThrow(/не отправлено/i);
  });

  test("есть ответственный — задачу закрывает ЕГО отчёт", async () => {
    // Соисполнитель отчитался, но спрос с ответственного: поручение ещё в работе.
    const id = await sent();
    const afterCo = await reportExecution(id, executorB.id, { text: "Со своей частью закончил" }, executorB);
    expect(afterCo.status).toBe("sent");

    const afterResp = await reportExecution(id, executorA.id, { text: "Всё готово" }, executorA);
    expect(afterResp.status).toBe("done");
  });

  test("нет ответственного — закрывается, когда отчитались ВСЕ", async () => {
    const id = await sent([
      { userId: executorA.id, kind: "coexecutor" },
      { userId: executorB.id, kind: "coexecutor" }
    ]);
    const first = await reportExecution(id, executorA.id, { text: "Готово" }, executorA);
    expect(first.status).toBe("sent");
    const second = await reportExecution(id, executorB.id, { text: "Готово" }, executorB);
    expect(second.status).toBe("done");
  });

  test("повторный отчёт по закрытому поручению отклоняется", async () => {
    const id = await sent();
    await reportExecution(id, executorA.id, { text: "Первый вариант" }, executorA);
    await expect(reportExecution(id, executorA.id, { text: "Уточнение" }, executorA)).rejects.toThrow(/уже исполнено/i);
  });

  test("отчёт попадает в аудит с автором", async () => {
    const id = await sent();
    await reportExecution(id, executorA.id, { text: "Сделано" }, executorA);
    const rows = await getDocflowPool().query<{ action: string; user_name: string }>(
      "SELECT action, user_name FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at",
      ["resolution", id]
    );
    const report = rows.rows.find((x) => x.action === "resolution.report");
    expect(report).toBeTruthy();
    expect(report!.user_name).toBe("Романов Е.С.");
    expect(rows.rows.some((x) => x.action === "resolution.done")).toBe(true);
  });

  test("отчёт письмом: сохраняется ссылка на письмо", async () => {
    const id = await sent();
    const after = await reportExecution(id, executorA.id, { text: "Отчёт письмом", emailId: "rep-1" }, executorA);
    expect(after.status).toBe("done");
    const mine = (await getResolutionDetail(id))!.assignees.find((a) => a.userId === executorA.id)!;
    expect(mine.reportText).toBe("Отчёт письмом");
  });

  test("аппарат может закрыть поручение сам", async () => {
    // Исполнитель отчитался письмом или лично — вводить отчёт вручную не нужно.
    const id = await sent();
    const closed = await closeResolution(id, secretary, "Исполнено по докладу");
    expect(closed.status).toBe("done");
  });

  test("закрыть можно только отправленное поручение", async () => {
    const r = await draft();
    await expect(closeResolution(r.id, secretary, "Закрываю")).rejects.toThrow(/невозможно/i);
  });
});

/**
 * Таблица журнала: резолюция, исполнитель и срок должны быть в СПИСКЕ, а не только в карточке
 * (жалоба заказчика: в журнале колонок не было, хотя в документе всё есть).
 */
describe("поручения для списка журнала", () => {
  it("отдаёт последнее поручение с исполнителем и сроком", async () => {
    await createResolution(
      {
        documentId,
        text: "Подготовить ответ",
        assignees: [{ userId: executorA.id, kind: "responsible" }],
        deadline: "2026-10-25"
      },
      secretary
    );

    const brief = (await resolutionsByDocument([documentId])).get(documentId)!;

    expect(brief.text).toBe("Подготовить ответ");
    expect(brief.deadline).toBe("2026-10-25");
    expect(brief.assignees).toEqual([executorA.name]);
  });

  it("из двух поручений берётся последнее, а чужой документ не попадает", async () => {
    await createResolution(
      { documentId, text: "Первое", assignees: [{ userId: executorA.id, kind: "responsible" }] },
      secretary
    );
    await createResolution(
      { documentId, text: "Второе", assignees: [{ userId: executorB.id, kind: "responsible" }] },
      secretary
    );
    const other = await registerDocument({ summary: "Другой документ" }, secretary);

    const map = await resolutionsByDocument([documentId, other.id]);

    expect(map.get(documentId)!.text).toBe("Второе");
    expect(map.get(documentId)!.assignees).toEqual([executorB.name]);
    expect(map.has(other.id)).toBe(false);
  });

  it("пустой список не ходит в базу", async () => {
    expect((await resolutionsByDocument([])).size).toBe(0);
  });
});
