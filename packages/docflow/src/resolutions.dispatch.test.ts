import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { registerDocument, type Actor } from "./journal.js";
import {
  approveResolution,
  attachDispatchEmail,
  attachRequestEmail,
  createResolution,
  dispatchResolution,
  forwardToManager,
  getResolution,
  getResolutionDetail,
  listReplyCandidates,
  reportExecution,
  requestApproval,
  revertDispatch
} from "./resolutions.js";

/**
 * Порядок отправки поручения (решение Lead):
 *   1) переход в sent — он же захват поручения (FOR UPDATE);
 *   2) письмо исполнителям;
 *   3) attachDispatchEmail — запись письма;
 *   4) сбой отправки → revertDispatch: возврат в approved, чтобы аппарат повторил.
 *
 * Проверяем два свойства, ради которых это разделено: письмо-поручение записывается
 * ровно одно (второго поручения быть не может), а неудачная отправка не оставляет
 * поручение «в работе» и не теряет уже отправленное письмо.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

const secretary: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };
const signer: Actor = { id: "u-signer", name: "Иванов И.И." };
const executorA: Actor = { id: "u-exec-a", name: "Романов Е.С." };
const executorB: Actor = { id: "u-exec-b", name: "Барышникова Л.С." };

let dir = "";
let documentId = "";

/** Запись в audit_log падает — проверяем, что и attach не проходит без следа. */
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

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(sql, params);
  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-dispatch-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await unblockAudit().catch(() => undefined);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await unblockAudit();
  await getDocflowPool().query(
    "TRUNCATE resolutions, resolution_assignees, resolution_approvals, documents, document_emails, " +
      "number_counters, number_archives, audit_log, users RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  for (const u of [secretary, signer, executorA, executorB]) {
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.id + "@stand.test", u.name, ts, ts]
    );
  }
  const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, secretary);
  documentId = doc.id;
});

afterEach(async () => {
  await unblockAudit();
});

/** Черновик → на утверждении → утверждён. */
async function approved() {
  const draft = await createResolution(
    {
      documentId,
      text: "Рассмотреть участие и подготовить заявку",
      assignees: [
        { userId: executorA.id, kind: "responsible" },
        { userId: executorB.id, kind: "coexecutor" }
      ]
    },
    secretary
  );
  await requestApproval(draft.id, secretary, {});
  await approveResolution(draft.id, signer, {});
  return draft.id;
}

/** Отправленное поручение без записанного письма: состояние сразу после перехода в sent. */
async function sent(): Promise<string> {
  const id = await approved();
  await dispatchResolution(id, secretary, {});
  const r = await getResolution(id);
  if (r?.status !== "sent") throw new Error("Подготовка теста: поручение не отправлено, статус " + r?.status);
  return id;
}

describe("attachDispatchEmail: письмо-поручение записывается ровно одно", () => {
  test("письмо записывается по отправленному поручению и попадает в аудит", async () => {
    const id = await sent();
    const after = await attachDispatchEmail(id, "mail-dispatch-1", secretary);
    expect(after.status).toBe("sent");
    expect(after.dispatchEmailId).toBe("mail-dispatch-1");
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.dispatch_email'")).toBe(1);
  });

  test("второе письмо по тому же поручению отклоняется", async () => {
    const id = await sent();
    await attachDispatchEmail(id, "mail-dispatch-1", secretary);
    // Второе письмо означало бы поручение, ушедшее дважды: такому не место в журнале.
    await expect(attachDispatchEmail(id, "mail-dispatch-2", secretary)).rejects.toThrow(/уже записано/);
    expect((await getResolution(id))!.dispatchEmailId).toBe("mail-dispatch-1");
  });

  test("повторный вызов с тем же письмом не считается ошибкой и не плодит следы", async () => {
    const id = await sent();
    await attachDispatchEmail(id, "mail-dispatch-1", secretary);
    const again = await attachDispatchEmail(id, "mail-dispatch-1", secretary);
    expect(again.dispatchEmailId).toBe("mail-dispatch-1");
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.dispatch_email'")).toBe(1);
  });

  test("по неотправленному поручению письмо не записывается", async () => {
    const id = await approved();
    await expect(attachDispatchEmail(id, "mail-dispatch-1", secretary)).rejects.toThrow(/только по отправленному/);
    expect((await getResolution(id))!.dispatchEmailId).toBeNull();
  });

  test("без идентификатора письма — понятная ошибка", async () => {
    const id = await sent();
    await expect(attachDispatchEmail(id, "   ", secretary)).rejects.toThrow(/Не указано письмо/);
  });

  test("сбой записи следа откатывает запись письма", async () => {
    const id = await sent();
    await blockAudit();
    await expect(attachDispatchEmail(id, "mail-dispatch-1", secretary)).rejects.toThrow();
    expect((await getResolution(id))!.dispatchEmailId).toBeNull();
  });
});

describe("revertDispatch: неудачная отправка возвращает поручение аппарату", () => {
  test("откат возвращает ровно в approved, письмо при этом не теряется", async () => {
    const id = await sent();
    await attachDispatchEmail(id, "mail-dispatch-1", secretary);

    const back = await revertDispatch(id, secretary, "Почтовый сервер не принял письмо");
    expect(back.status).toBe("approved");
    // Письмо могло реально уйти (таймаут на нашей стороне) — его id сохраняем:
    // по нему письмо находится в почте, а следующая отправка перезапишет поле.
    expect(back.dispatchEmailId).toBe("mail-dispatch-1");
    expect(back.dispatchedBy).toBeNull();
    expect(back.dispatchedAt).toBeNull();

    const detail = (await getResolutionDetail(id))!;
    const last = detail.history[detail.history.length - 1];
    expect(last.step).toBe("dispatch_failed");
    expect(last.comment).toContain("не принял письмо");
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.dispatch_failed'")).toBe(1);
  });

  test("после отката поручение можно отправить снова — с новым письмом", async () => {
    const id = await sent();
    await attachDispatchEmail(id, "mail-dispatch-1", secretary);
    await revertDispatch(id, secretary, "Почтовый сервер не принял письмо");

    const again = await dispatchResolution(id, secretary, {});
    expect(again.status).toBe("sent");
    const attached = await attachDispatchEmail(id, "mail-dispatch-2", secretary);
    expect(attached.dispatchEmailId).toBe("mail-dispatch-2");
  });

  test("откат запрещён, когда исполнитель уже отчитался", async () => {
    const id = await sent();
    // Отчёт соисполнителя: ответственный не отчитался, поручение осталось «в работе».
    await reportExecution(id, executorB.id, { text: "Заявка подготовлена" }, executorB);
    expect((await getResolution(id))!.status).toBe("sent");
    // Работа идёт: откат открыл бы повторную отправку — второе письмо по тому же поручению.
    await expect(revertDispatch(id, secretary, "Письмо не ушло")).rejects.toThrow(/уже отчитался/);
    expect((await getResolution(id))!.status).toBe("sent");
  });

  test("откатывается только отправленное поручение", async () => {
    const id = await approved();
    await expect(revertDispatch(id, secretary, "Письмо не ушло")).rejects.toThrow(/невозможно/);
    expect((await getResolution(id))!.status).toBe("approved");
  });

  test("без причины откат не делается", async () => {
    const id = await sent();
    await expect(revertDispatch(id, secretary, "   ")).rejects.toThrow(/причину/);
    expect((await getResolution(id))!.status).toBe("sent");
  });

  test("откат и его след — одна транзакция", async () => {
    const id = await sent();
    await blockAudit();
    await expect(revertDispatch(id, secretary, "Письмо не ушло")).rejects.toThrow();
    // Письма нет — поручение обязано остаться отправленным, а не «подвиснуть» посередине.
    expect((await getResolution(id))!.status).toBe("sent");
  });
});

describe("attachRequestEmail: письмо-запрос, по которому отвечает руководитель", () => {
  /** Письмо направлено руководителю: запись создана до отправки, id письма ещё не записан. */
  async function forwarded(): Promise<string> {
    const r = await forwardToManager(documentId, secretary, {});
    expect(r.status).toBe("pending_approval");
    expect(r.requestEmailId).toBeNull();
    return r.id;
  }

  test("после записи письмо находится как кандидат ответа, а история перестаёт врать про «вручную»", async () => {
    const id = await forwarded();

    const after = await attachRequestEmail(id, "mail-request-1", secretary);
    expect(after.requestEmailId).toBe("mail-request-1");
    expect(
      await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.request_email'")
    ).toBe(1);

    // Главное: без requestEmailId ответ руководителя письмом не сопоставить с поручением.
    const found = (await listReplyCandidates()).find((c) => c.resolutionId === id);
    expect(found).toBeDefined();
    expect(found!.expects).toBe("approval");
    expect(found!.emailId).toBe("mail-request-1");

    const detail = (await getResolutionDetail(id))!;
    const requested = detail.history.filter((h) => h.step === "requested");
    expect(requested).toHaveLength(1);
    expect(requested[0].method).toBe("email");
    expect(requested[0].emailId).toBe("mail-request-1");
  });

  test("повторная запись того же письма безопасна и не плодит следы", async () => {
    const id = await forwarded();
    await attachRequestEmail(id, "mail-request-1", secretary);

    const again = await attachRequestEmail(id, "mail-request-1", secretary);
    expect(again.requestEmailId).toBe("mail-request-1");
    expect(
      await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'resolution.request_email'")
    ).toBe(1);
  });

  test("второе письмо по тому же поручению отклоняется", async () => {
    const id = await forwarded();
    await attachRequestEmail(id, "mail-request-1", secretary);

    await expect(attachRequestEmail(id, "mail-request-2", secretary)).rejects.toThrow(/уже записано/);
    expect((await getResolution(id))!.requestEmailId).toBe("mail-request-1");
  });

  test("по поручению, которое уже не ждёт решения руководителя, письмо не записывается", async () => {
    const id = await approved();
    await expect(attachRequestEmail(id, "mail-request-1", secretary)).rejects.toThrow(/ждёт решения руководителя/);
    expect((await getResolution(id))!.requestEmailId).toBeNull();
  });

  test("без идентификатора письма — понятная ошибка", async () => {
    const id = await forwarded();
    await expect(attachRequestEmail(id, "   ", secretary)).rejects.toThrow(/Не указано письмо/);
  });

  test("сбой записи следа откатывает и запись письма, и правку истории", async () => {
    const id = await forwarded();
    await blockAudit();

    await expect(attachRequestEmail(id, "mail-request-1", secretary)).rejects.toThrow();
    expect((await getResolution(id))!.requestEmailId).toBeNull();
    const detail = (await getResolutionDetail(id))!;
    expect(detail.history.find((h) => h.step === "requested")!.method).toBe("manual");
  });
});
