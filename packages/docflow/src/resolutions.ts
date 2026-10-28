/**
 * Резолюции: подготовка черновика, утверждение подписантом, отправка исполнителям (этап 3).
 *
 * Ключевое правило: решение и диспетчеризация разведены по разным людям (Р8, Р9).
 * Аппарат готовит и отправляет, подписант утверждает. Состояния переходят только
 * по разрешённым путям — попытка обойти шаг возвращает понятную ошибку, а не молча
 * создаёт поручение без подписи.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import type { DocflowTx } from "./repo.js";
import { docflowSchema } from "./db/schema.js";
import { AppError } from "./errors.js";
import { daysLeft, isOverdue } from "./deadlines.js";
import { getDueSoonDays, notifyInTx, type NotificationKind } from "./notifications.js";
import type {
  ApprovalMethod,
  ApprovalStep,
  HistoryMethod,
  AssigneeKind,
  ResolutionApprovalEntry,
  ResolutionAssignee,
  ResolutionDetail,
  ResolutionFilter,
  ResolutionPage,
  ResolutionPriority,
  ResolutionRecord,
  ResolutionStatus,
  TaskItem
} from "./types.js";
import type { Actor } from "./journal.js";

const { resolutions, resolutionAssignees, resolutionApprovals, documents, users, auditLog } = docflowSchema;

const countExpr = sql.raw("count(*)::int");

function now(): string {
  return new Date().toISOString();
}

function stringify(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function mapResolution(row: typeof resolutions.$inferSelect): ResolutionRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    text: row.text,
    sourceText: row.sourceText,
    sourceKind: row.sourceKind as ResolutionRecord["sourceKind"],
    status: row.status as ResolutionStatus,
    priority: row.priority as ResolutionPriority,
    deadline: row.deadline,
    preparedBy: row.preparedBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    approvalMethod: (row.approvalMethod as ApprovalMethod | null) ?? null,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    dispatchedBy: row.dispatchedBy,
    dispatchedAt: row.dispatchedAt,
    requestEmailId: row.requestEmailId,
    approvalEmailId: row.approvalEmailId,
    dispatchEmailId: row.dispatchEmailId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Сроки считаются в календарных днях — см. deadlines.ts. Функции реэкспортируются,
 * потому что их исторически берут отсюда (listMyTasks, канбан, тесты).
 */
export { daysLeft, isOverdue };

/** Ожидаемые отказы: неверный шаг, нет прав на действие, пустые обязательные поля. */
function badState(message: string): AppError {
  return new AppError(message, 409, "bad_state");
}

// ---------------- Чтение ----------------

/**
 * Резолюции, ждущие ответа руководителя по пересланному письму.
 *
 * Возвращаем вместе с `requestEmailId`: по нему вызывающий код найдёт письмо в почтовой
 * базе и получит его Message-ID. Сопоставление делает `matchReplies` — здесь только выборка.
 */
export async function listAwaitingReplies(): Promise<
  Array<{ resolutionId: string; requestEmailId: string }>
> {
  const rows = await getDocflowDb()
    .select({ id: resolutions.id, requestEmailId: resolutions.requestEmailId })
    .from(resolutions)
    .where(and(eq(resolutions.status, "pending_approval"), eq(resolutions.sourceKind, "forwarded")));
  return rows
    .filter((r) => !!r.requestEmailId)
    .map((r) => ({ resolutionId: r.id, requestEmailId: r.requestEmailId as string }));
}

export async function getResolution(id: string): Promise<ResolutionRecord | null> {
  const rows = await getDocflowDb().select().from(resolutions).where(eq(resolutions.id, id)).limit(1);
  return rows[0] ? mapResolution(rows[0]) : null;
}

type AssigneeRow = {
  a: typeof resolutionAssignees.$inferSelect;
  fullName: string | null;
  email: string | null;
};

function mapAssignees(rows: AssigneeRow[]): ResolutionAssignee[] {
  return rows
    .map((r) => ({
      userId: r.a.userId,
      fullName: r.fullName ?? "",
      email: r.email ?? "",
      kind: r.a.kind as AssigneeKind,
      receivedAt: r.a.receivedAt,
      reportText: r.a.reportText,
      reportAt: r.a.reportAt
    }))
    // Ответственный — первым: с него спрос.
    .sort((a, b) => (a.kind === b.kind ? a.fullName.localeCompare(b.fullName, "ru") : a.kind === "responsible" ? -1 : 1));
}

function mapHistory(rows: Array<typeof resolutionApprovals.$inferSelect>): ResolutionApprovalEntry[] {
  return rows.map((r) => ({
    id: r.id,
    step: r.step as ApprovalStep,
    actorId: r.actorId,
    actorName: r.actorName,
    method: (r.method as HistoryMethod | null) ?? null,
    comment: r.comment,
    emailId: r.emailId,
    createdAt: r.createdAt
  }));
}

export async function listResolutionAssignees(resolutionId: string): Promise<ResolutionAssignee[]> {
  const rows = await getDocflowDb()
    .select({ a: resolutionAssignees, fullName: users.fullName, email: users.email })
    .from(resolutionAssignees)
    .leftJoin(users, eq(users.id, resolutionAssignees.userId))
    .where(eq(resolutionAssignees.resolutionId, resolutionId));
  return mapAssignees(rows);
}

/**
 * Исполнители сразу для набора резолюций — ОДИН запрос вместо запроса на строку.
 * Нужен спискам и канбану: там на каждой строке висят исполнители.
 */
async function assigneesForResolutions(ids: string[]): Promise<Map<string, ResolutionAssignee[]>> {
  const out = new Map<string, ResolutionAssignee[]>();
  if (!ids.length) return out;
  const rows = await getDocflowDb()
    .select({ a: resolutionAssignees, fullName: users.fullName, email: users.email })
    .from(resolutionAssignees)
    .leftJoin(users, eq(users.id, resolutionAssignees.userId))
    .where(inArray(resolutionAssignees.resolutionId, ids));
  const grouped = new Map<string, AssigneeRow[]>();
  for (const r of rows) {
    const arr = grouped.get(r.a.resolutionId) ?? [];
    arr.push(r);
    grouped.set(r.a.resolutionId, arr);
  }
  for (const [resId, list] of grouped) out.set(resId, mapAssignees(list));
  return out;
}

/** История шагов сразу для набора резолюций — один запрос вместо запроса на строку. */
async function historyForResolutions(ids: string[]): Promise<Map<string, ResolutionApprovalEntry[]>> {
  const out = new Map<string, ResolutionApprovalEntry[]>();
  if (!ids.length) return out;
  const rows = await getDocflowDb()
    .select()
    .from(resolutionApprovals)
    .where(inArray(resolutionApprovals.resolutionId, ids))
    .orderBy(asc(resolutionApprovals.createdAt));
  const grouped = new Map<string, Array<typeof resolutionApprovals.$inferSelect>>();
  for (const r of rows) {
    const arr = grouped.get(r.resolutionId) ?? [];
    arr.push(r);
    grouped.set(r.resolutionId, arr);
  }
  for (const [resId, list] of grouped) out.set(resId, mapHistory(list));
  return out;
}

export async function listResolutionHistory(resolutionId: string): Promise<ResolutionApprovalEntry[]> {
  const rows = await getDocflowDb()
    .select()
    .from(resolutionApprovals)
    .where(eq(resolutionApprovals.resolutionId, resolutionId))
    .orderBy(asc(resolutionApprovals.createdAt));
  return mapHistory(rows);
}

/**
 * Детали набора резолюций — ПАКЕТНО, фиксированным числом запросов.
 *
 * Раньше каждая строка списка стоила пяти запросов (резолюция, документ, участники,
 * исполнители, история): канбан на 200 записей давал около тысячи обращений к базе.
 * Здесь пять запросов на всю выдачу, и их число не зависит от числа строк.
 */
async function resolutionDetails(ids: string[]): Promise<Map<string, ResolutionDetail>> {
  const out = new Map<string, ResolutionDetail>();
  if (!ids.length) return out;
  const db = getDocflowDb();
  // Тот же порог, что у уведомлений о сроках (А5, А11): одна настройка на весь продукт.
  const dueSoonDays = await getDueSoonDays();

  const recs = await db.select().from(resolutions).where(inArray(resolutions.id, ids));
  if (!recs.length) return out;

  const docIds = [...new Set(recs.map((r) => r.documentId))];
  const docs = await db.select().from(documents).where(inArray(documents.id, docIds));
  const docById = new Map(docs.map((d) => [d.id, d]));

  const userIds = [
    ...new Set(
      recs
        .flatMap((r) => [r.preparedBy, r.approvedBy, r.confirmedBy, r.dispatchedBy])
        .filter((v): v is string => !!v)
    )
  ];
  const names = userIds.length
    ? await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds))
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.fullName]));

  const assignees = await assigneesForResolutions(ids);
  const history = await historyForResolutions(ids);

  for (const rec of recs) {
    const doc = docById.get(rec.documentId);
    const nameOf = (uid: string | null): string => (uid ? nameById.get(uid) ?? "" : "");
    const left = daysLeft(rec.deadline);
    out.set(rec.id, {
      ...mapResolution(rec),
      assignees: assignees.get(rec.id) ?? [],
      history: history.get(rec.id) ?? [],
      // Подсветка срока: только у поручения «в работе» — исполненное не бывает «скоро».
      daysLeft: left,
      overdue: rec.status === "sent" && isOverdue(rec.deadline),
      dueSoon: rec.status === "sent" && left !== null && left >= 0 && left <= dueSoonDays,
      documentNumber: doc?.regNumber ?? "",
      documentSummary: doc?.summary ?? doc?.documentName ?? "",
      documentEmailId: doc?.emailId ?? null,
      preparedByName: nameOf(rec.preparedBy),
      approvedByName: nameOf(rec.approvedBy),
      dispatchedByName: nameOf(rec.dispatchedBy),
      confirmedByName: nameOf(rec.confirmedBy)
    });
  }
  return out;
}

/** Резолюция со всем, что нужно экрану: исполнители, история, документ, ФИО участников. */
export async function getResolutionDetail(id: string): Promise<ResolutionDetail | null> {
  return (await resolutionDetails([id])).get(id) ?? null;
}

/** Детали нескольких резолюций — в порядке переданных id. */
async function resolutionDetailsInOrder(ids: string[]): Promise<ResolutionDetail[]> {
  const map = await resolutionDetails(ids);
  return ids.map((id) => map.get(id)).filter((d): d is ResolutionDetail => !!d);
}
// ---------------- Переходы состояний ----------------

/**
 * Общая часть любого перехода: меняем состояние, пишем шаг в историю и след в аудит —
 * всё в одной транзакции. Иначе «кто утвердил» могло потеряться, а это главный вопрос
 * при разборе ошибки.
 */
async function applyTransition(
  id: string,
  actor: Actor,
  opts: {
    from: ResolutionStatus[];
    to: ResolutionStatus;
    patch?: Record<string, unknown>;
    step: ApprovalStep;
    method?: HistoryMethod | null;
    comment?: string | null;
    emailId?: string | null;
    action: string;
    /**
     * Дополнительная проверка ВНУТРИ транзакции — уже после блокировки строки.
     * Нужна переходам, у которых есть условие помимо состояния резолюции:
     * снаружи транзакции его можно обойти гонкой.
     */
    guard?: (tx: DocflowTx) => Promise<void>;
    /**
     * Событийное уведомление В ТОЙ ЖЕ транзакции, что и переход (§3). Отдельным хуком,
     * а не «сбоку после вызова»: тогда уведомление и изменение либо оба есть, либо обоих нет.
     */
    afterChange?: (tx: DocflowTx, row: typeof resolutions.$inferSelect) => Promise<void>;
  }
): Promise<ResolutionRecord> {
  const db = getDocflowDb();
  return db.transaction(async (tx) => {
    // FOR UPDATE — иначе два одновременных перехода читают одно и то же состояние
    // и оба «проходят»: поручение уходит дважды, а в истории две записи об отправке.
    const rows = await tx.select().from(resolutions).where(eq(resolutions.id, id)).limit(1).for("update");
    const current = rows[0];
    if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
    if (!opts.from.includes(current.status as ResolutionStatus)) {
      throw badState(
        "Действие невозможно: резолюция в состоянии «" + current.status + "», ожидалось " + opts.from.join(" или ")
      );
    }
    if (opts.guard) await opts.guard(tx);

    const ts = now();
    await tx
      .update(resolutions)
      .set({ status: opts.to, updatedAt: ts, ...(opts.patch ?? {}) })
      .where(eq(resolutions.id, id));

    await tx.insert(resolutionApprovals).values({
      id: randomUUID(),
      resolutionId: id,
      step: opts.step,
      actorId: actor.id,
      actorName: actor.name,
      method: opts.method ?? null,
      comment: opts.comment ?? null,
      emailId: opts.emailId ?? null,
      createdAt: ts
    });

    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: opts.action,
      entityType: "resolution",
      entityId: id,
      oldValue: stringify({ status: current.status }),
      newValue: stringify({ status: opts.to, ...(opts.patch ?? {}), comment: opts.comment ?? null }),
      createdAt: ts
    });

    const after = await tx.select().from(resolutions).where(eq(resolutions.id, id)).limit(1);
    if (opts.afterChange) await opts.afterChange(tx, after[0]);
    return mapResolution(after[0]);
  });
}

type ResolutionRow = typeof resolutions.$inferSelect;

/**
 * Переменные шаблона уведомления. Имена заморожены приложением А2 контракта:
 * {regNumber}, {summary}, {sender}, {deadline}, {daysLeft}, {text}, {author}.
 * {sender} берётся из письма (почтовая база) и здесь недоступен — остаётся как есть.
 */
async function notificationVars(
  tx: DocflowTx,
  row: ResolutionRow,
  author = ""
): Promise<Record<string, string | number>> {
  const doc = (
    await tx
      .select({ regNumber: documents.regNumber, summary: documents.summary })
      .from(documents)
      .where(eq(documents.id, row.documentId))
      .limit(1)
  )[0];
  return {
    regNumber: doc?.regNumber ?? "",
    summary: doc?.summary ?? "",
    deadline: row.deadline ?? "не указан",
    text: row.text,
    author
  };
}

/**
 * Событийное уведомление резолюции — внутри переданной транзакции.
 *
 * Ключ включает отметку времени события: повторная отправка после отката — это новое
 * событие и новое уведомление, а «двойной клик» по одному переходу второго перехода не даёт.
 */
async function notifyResolutionEvent(
  tx: DocflowTx,
  opts: {
    kind: NotificationKind;
    resolution: ResolutionRow;
    userIds: Array<string | null>;
    stamp: string;
    author?: string;
  }
): Promise<void> {
  const vars = await notificationVars(tx, opts.resolution, opts.author ?? "");
  for (const userId of [...new Set(opts.userIds.filter((v): v is string => !!v))]) {
    await notifyInTx(tx, {
      userId,
      kind: opts.kind,
      entityId: opts.resolution.id,
      dedupeKey: opts.kind + ":" + opts.resolution.id + ":" + userId + ":" + opts.stamp,
      vars
    });
  }
}

/** Закрытие поручения: узнают утвердивший и все исполнители (§3). */
async function notifyClosed(tx: DocflowTx, row: ResolutionRow, actor: Actor): Promise<void> {
  await notifyResolutionEvent(tx, {
    kind: "resolution.closed",
    resolution: row,
    userIds: [row.approvedBy, ...(await assigneeIdsIn(tx, row.id))],
    stamp: row.updatedAt,
    author: actor.name
  });
}

/** Исполнители поручения — кому адресовано уведомление. */
async function assigneeIdsIn(tx: DocflowTx, resolutionId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: resolutionAssignees.userId })
    .from(resolutionAssignees)
    .where(eq(resolutionAssignees.resolutionId, resolutionId));
  return rows.map((r) => r.userId);
}

export interface AssigneeInput {
  userId: string;
  kind?: AssigneeKind;
}

/**
 * Проверяет список исполнителей: хотя бы один, все существуют, ответственный не дублируется.
 * Уникальность ответственного дополнительно гарантирует частичный индекс в БД.
 */
async function validateAssignees(list: AssigneeInput[]): Promise<void> {
  if (!list.length) throw new AppError("Укажите хотя бы одного исполнителя", 400, "no_assignees");
  const ids = list.map((a) => a.userId);
  if (new Set(ids).size !== ids.length) throw new AppError("Исполнители повторяются", 400, "duplicate_assignee");
  if (list.filter((a) => a.kind === "responsible").length > 1) {
    throw new AppError("Ответственный может быть только один", 400, "many_responsible");
  }
  const found = await getDocflowDb().select({ id: users.id }).from(users).where(inArray(users.id, ids));
  const known = new Set(found.map((f) => f.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new AppError("Исполнитель не найден в справочнике: " + missing.join(", "), 400, "unknown_assignee");
}

export interface CreateResolutionInput {
  documentId: string;
  text: string;
  /** Исходный текст до правок: что предложил ИИ или что написал подписант. */
  sourceText?: string;
  sourceKind?: "manual" | "ai" | "email" | "forwarded";
  priority?: ResolutionPriority;
  deadline?: string | null;
  assignees: AssigneeInput[];
}

/** Создаёт черновик резолюции по документу. Отправка — отдельным шагом. */
export async function createResolution(input: CreateResolutionInput, actor: Actor): Promise<ResolutionRecord> {
  const text = (input.text ?? "").trim();
  if (!text) throw new AppError("Текст резолюции пуст", 400, "empty_text");
  const doc = await getDocflowDb().select({ id: documents.id }).from(documents).where(eq(documents.id, input.documentId)).limit(1);
  if (!doc[0]) throw new AppError("Документ не найден", 404, "not_found");
  await validateAssignees(input.assignees);

  const db = getDocflowDb();
  const id = randomUUID();
  const ts = now();
  await db.transaction(async (tx) => {
    await tx.insert(resolutions).values({
      id,
      documentId: input.documentId,
      text,
      sourceText: input.sourceText ?? "",
      sourceKind: input.sourceKind ?? "manual",
      status: "draft",
      priority: input.priority ?? "normal",
      deadline: input.deadline ?? null,
      preparedBy: actor.id,
      createdAt: ts,
      updatedAt: ts
    });
    await tx.insert(resolutionAssignees).values(
      input.assignees.map((a) => ({
        resolutionId: id,
        userId: a.userId,
        // Первый по умолчанию ответственный — обычная практика (Р10),
        // но признак можно снять: тогда все равны.
        kind: (a.kind ?? "coexecutor") as AssigneeKind,
        createdAt: ts
      }))
    );
    await tx.insert(resolutionApprovals).values({
      id: randomUUID(),
      resolutionId: id,
      step: "requested",
      actorId: actor.id,
      actorName: actor.name,
      method: "manual",
      comment: "Черновик создан",
      createdAt: ts
    });
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.create",
      entityType: "resolution",
      entityId: id,
      newValue: stringify({ documentId: input.documentId, priority: input.priority ?? "normal", assignees: input.assignees }),
      createdAt: ts
    });
  });
  return (await getResolution(id))!;
}
/** Правка черновика. После утверждения текст менять нельзя — это подписанный документ. */
export async function updateResolution(
  id: string,
  patch: { text?: string; priority?: ResolutionPriority; deadline?: string | null; assignees?: AssigneeInput[] },
  actor: Actor
): Promise<ResolutionRecord> {
  const current = await getResolution(id);
  if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
  if (current.status !== "draft") {
    throw badState("Резолюция уже отправлена на утверждение — текст менять нельзя");
  }
  if (patch.assignees) await validateAssignees(patch.assignees);
  if (patch.text !== undefined && !patch.text.trim()) throw new AppError("Текст резолюции пуст", 400, "empty_text");

  const db = getDocflowDb();
  const ts = now();
  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = { updatedAt: ts };
    if (patch.text !== undefined) set.text = patch.text.trim();
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.deadline !== undefined) set.deadline = patch.deadline;
    await tx.update(resolutions).set(set).where(eq(resolutions.id, id));

    if (patch.assignees) {
      await tx.delete(resolutionAssignees).where(eq(resolutionAssignees.resolutionId, id));
      await tx.insert(resolutionAssignees).values(
        patch.assignees.map((a) => ({
          resolutionId: id,
          userId: a.userId,
          kind: (a.kind ?? "coexecutor") as AssigneeKind,
          createdAt: ts
        }))
      );
    }

    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.edit",
      entityType: "resolution",
      entityId: id,
      oldValue: stringify({ text: current.text, priority: current.priority, deadline: current.deadline }),
      newValue: stringify(patch),
      createdAt: ts
    });
  });
  return (await getResolution(id))!;
}

/** Черновик → на утверждении. Отправляет аппарат. */
export async function requestApproval(
  id: string,
  actor: Actor,
  opts: { requestEmailId?: string | null } = {}
): Promise<ResolutionRecord> {
  const current = await getResolution(id);
  if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
  if (current.status !== "draft") throw badState("На утверждение отправляется только черновик");
  if (!current.text.trim()) throw new AppError("Текст резолюции пуст", 400, "empty_text");
  const assignees = await listResolutionAssignees(id);
  if (!assignees.length) throw new AppError("Не указаны исполнители", 400, "no_assignees");

  return applyTransition(id, actor, {
    from: ["draft"],
    to: "pending_approval",
    patch: { requestEmailId: opts.requestEmailId ?? null },
    step: "requested",
    method: opts.requestEmailId ? "email" : "app",
    emailId: opts.requestEmailId ?? null,
    action: "resolution.request_approval"
  });
}

/**
 * Способ А: подписант утверждает в приложении. Отправка — отдельный шаг аппарата.
 *
 * Подписант вправе **здесь же** написать текст и назначить исполнителей: по Р8 решение
 * принимает он, а не аппарат. Но только в момент утверждения — после текст заморожен,
 * иначе подписанное можно было бы изменить задним числом.
 */

/**
 * Заменяет исполнителей целиком. Отдельно от `updateResolution`, потому что вызывается
 * и при утверждении подписантом — когда черновик ему не принадлежит.
 */
async function replaceAssignees(id: string, list: AssigneeInput[], actor: Actor): Promise<void> {
  const db = getDocflowDb();
  const ts = now();
  const before = await listResolutionAssignees(id);
  await db.transaction(async (tx) => {
    await tx.delete(resolutionAssignees).where(eq(resolutionAssignees.resolutionId, id));
    await tx.insert(resolutionAssignees).values(
      list.map((a) => ({
        resolutionId: id,
        userId: a.userId,
        kind: (a.kind ?? "coexecutor") as AssigneeKind,
        createdAt: ts
      }))
    );
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.assignees",
      entityType: "resolution",
      entityId: id,
      oldValue: stringify(before.map((a) => ({ userId: a.userId, kind: a.kind }))),
      newValue: stringify(list),
      createdAt: ts
    });
  });
}

/**
 * Аппарат направляет письмо руководителю — первый шаг реального документооборота.
 *
 * Это НЕ «отправка на утверждение» готового черновика: резолюции ещё нет, есть только
 * письмо. Руководитель сам решает, что поручить и кому. Поэтому запись создаётся сразу
 * в состоянии «на утверждении», с пустым текстом и без исполнителей — их он впишет сам
 * (в приложении) либо предложит ответом письмом, а аппарат подтвердит.
 */
export async function forwardToManager(
  documentId: string,
  actor: Actor,
  opts: { emailId?: string | null; comment?: string | null } = {}
): Promise<ResolutionRecord> {
  const doc = await getDocflowDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc[0]) throw new AppError("Документ не найден", 404, "not_found");

  // Повторная пересылка создала бы дубль резолюции — не даём, пока по первой нет решения.
  const existing = await getDocflowDb()
    .select({ id: resolutions.id, status: resolutions.status })
    .from(resolutions)
    .where(and(eq(resolutions.documentId, documentId), eq(resolutions.sourceKind, "forwarded")));
  const active = existing.find((r) => r.status === "pending_approval" || r.status === "email_approval");
  if (active) throw badState("Письмо уже направлено руководителю — ждём резолюции");

  const id = randomUUID();
  const ts = now();
  const db = getDocflowDb();
  await db.transaction(async (tx) => {
    await tx.insert(resolutions).values({
      id,
      documentId,
      // Текст пуст намеренно: его напишет руководитель.
      text: "",
      sourceText: opts.comment ?? "",
      sourceKind: "forwarded",
      status: "pending_approval",
      priority: "normal",
      deadline: null,
      preparedBy: actor.id,
      requestEmailId: opts.emailId ?? null,
      createdAt: ts,
      updatedAt: ts
    });
    await tx.insert(resolutionApprovals).values({
      id: randomUUID(),
      resolutionId: id,
      step: "requested",
      actorId: actor.id,
      actorName: actor.name,
      method: opts.emailId ? "email" : "manual",
      emailId: opts.emailId ?? null,
      comment: opts.comment ?? "Письмо направлено руководителю",
      createdAt: ts
    });
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.forward",
      entityType: "resolution",
      entityId: id,
      newValue: stringify({ documentId, emailId: opts.emailId ?? null }),
      createdAt: ts
    });
  });
  return (await getResolution(id))!;
}
export async function approveResolution(
  id: string,
  actor: Actor,
  opts: {
    comment?: string;
    text?: string;
    assignees?: AssigneeInput[];
    priority?: ResolutionPriority;
    deadline?: string | null;
    /** Письмо-подтверждение из Outlook: им и регистрируется резолюция. */
    emailId?: string | null;
  } = {}
): Promise<ResolutionRecord> {
  const text = opts.text !== undefined ? opts.text.trim() : undefined;
  if (text !== undefined && !text) {
    throw new AppError("Текст резолюции пуст", 400, "empty_text");
  }
  if (opts.assignees) await validateAssignees(opts.assignees);

  const patch: Record<string, unknown> = {
    approvedBy: actor.id,
    approvedAt: now(),
    approvalMethod: opts.emailId ? "email" : "app",
    approvalEmailId: opts.emailId ?? null
  };
  if (text !== undefined) patch.text = text;
  if (opts.priority !== undefined) patch.priority = opts.priority;
  if (opts.deadline !== undefined) patch.deadline = opts.deadline;

  const result = await applyTransition(id, actor, {
    from: ["pending_approval"],
    to: "approved",
    patch,
    step: "approved",
    method: opts.emailId ? "email" : "app",
    emailId: opts.emailId ?? null,
    comment: opts.comment ?? null,
    action: "resolution.approve",
    // Аппарат (prepared_by) должен узнать, что решение принято: без этого поручение
    // «утверждено» ждало бы отправки, о которой никто не помнит (§3).
    afterChange: async (tx, row) => {
      await notifyResolutionEvent(tx, {
        kind: "resolution.approved",
        resolution: row,
        userIds: [row.preparedBy],
        stamp: row.approvedAt ?? row.updatedAt,
        author: actor.name
      });
    }
  });

  // Исполнителей меняем после перехода: так они попадают в тот же след аудита,
  // но уникальность ответственного проверяется уже по новому набору.
  if (opts.assignees) await replaceAssignees(id, opts.assignees, actor);
  return (await getResolution(id)) ?? result;
}

/**
 * Способ В, шаг 1: пришёл ответ подписанта письмом.
 *
 * Система НЕ отправляет поручение сама: разбор свободного текста не может быть
 * основанием для официального поручения (Р9). Резолюция ждёт подтверждения аппарата,
 * а текст ответа сохраняется отдельно — аппарат решит, брать его в резолюцию или нет.
 */
export async function markEmailApproval(
  id: string,
  input: { emailId: string; replyText: string },
  actor: Actor
): Promise<ResolutionRecord> {
  return applyTransition(id, actor, {
    from: ["pending_approval"],
    to: "email_approval",
    // Подписанта фиксируем СРАЗУ: он уже подписал, ждём лишь подтверждения разбора.
    // `approvedAt` при этом пуст — утверждённым резолюция ещё не стала.
    patch: { approvalMethod: "email", approvalEmailId: input.emailId, approvedBy: actor.id },
    step: "approved",
    method: "email",
    emailId: input.emailId,
    comment: input.replyText,
    action: "resolution.email_approval"
  });
}

/**
 * Способ В, шаг 2: аппарат проверил ответ и подтверждает.
 * Без этого шага резолюция исполнителям не уйдёт.
 */
export async function confirmEmailApproval(
  id: string,
  actor: Actor,
  opts: {
    approvedBy?: string | null;
    comment?: string;
    /** Аппарат может вписать текст и исполнителей: в письме они пришли свободным текстом. */
    text?: string;
    assignees?: AssigneeInput[];
    priority?: ResolutionPriority;
    deadline?: string | null;
  } = {}
): Promise<ResolutionRecord> {
  const text = opts.text !== undefined ? opts.text.trim() : undefined;
  if (text !== undefined && !text) throw new AppError("Текст резолюции пуст", 400, "empty_text");
  if (opts.assignees) await validateAssignees(opts.assignees);

  const current = await getResolution(id);
  if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");

  const patch: Record<string, unknown> = {
    // Автор решения — подписант. Он уже записан при распознавании ответа; здесь его
    // НЕ обнуляем (`opts.approvedBy ?? null` терял подпись, и в журнале графа
    // «Резолюция руководства» оставалась пустой). Аппарат может указать подписанта
    // вручную — если система не смогла определить его по адресу отправителя.
    approvedBy: opts.approvedBy ?? current.approvedBy,
    approvedAt: now(),
    confirmedBy: actor.id,
    confirmedAt: now()
  };
  if (text !== undefined) patch.text = text;
  if (opts.priority !== undefined) patch.priority = opts.priority;
  if (opts.deadline !== undefined) patch.deadline = opts.deadline;

  const result = await applyTransition(id, actor, {
    from: ["email_approval"],
    to: "approved",
    patch,
    step: "confirmed",
    method: "email",
    comment: opts.comment ?? null,
    action: "resolution.confirm_approval",
    // Второй путь утверждения (ответ письмом) сообщает аппарату то же самое.
    afterChange: async (tx, row) => {
      await notifyResolutionEvent(tx, {
        kind: "resolution.approved",
        resolution: row,
        userIds: [row.preparedBy],
        stamp: row.approvedAt ?? row.updatedAt,
        author: actor.name
      });
    }
  });
  if (opts.assignees) await replaceAssignees(id, opts.assignees, actor);
  return (await getResolution(id)) ?? result;
}

/** Вернуть на доработку: подписант не согласен либо аппарат нашёл ошибку. */
export async function rejectResolution(id: string, actor: Actor, comment: string): Promise<ResolutionRecord> {
  return applyTransition(id, actor, {
    from: ["pending_approval", "email_approval"],
    to: "draft",
    patch: { approvedBy: null, approvedAt: null, approvalMethod: null, confirmedBy: null, confirmedAt: null },
    step: "rejected",
    comment,
    action: "resolution.reject"
  });
}

/**
 * Утверждено → отправлено исполнителям. Всегда аппарат (Р9).
 * Именно здесь поручение становится задачей: до этого шага исполнители его не видят.
 */
export async function dispatchResolution(
  id: string,
  actor: Actor,
  opts: { dispatchEmailId?: string | null; comment?: string } = {}
): Promise<ResolutionRecord> {
  // Проверяем ПЕРЕД переходом: поручение без текста или без исполнителя — не поручение.
  // Особенно важно для пути «письмо руководителю»: там резолюция создаётся пустой.
  const current = await getResolution(id);
  if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
  if (!current.text.trim()) throw new AppError("Резолюция без текста — отправлять нечего", 400, "empty_text");
  const assignees = await listResolutionAssignees(id);
  if (!assignees.length) throw new AppError("Не назначен ни один исполнитель", 400, "no_assignees");

  return applyTransition(id, actor, {
    from: ["approved"],
    to: "sent",
    patch: {
      dispatchedBy: actor.id,
      dispatchedAt: now(),
      dispatchEmailId: opts.dispatchEmailId ?? null
    },
    step: "dispatched",
    method: opts.dispatchEmailId ? "email" : "manual",
    emailId: opts.dispatchEmailId ?? null,
    comment: opts.comment ?? null,
    action: "resolution.dispatch",
    // Уведомление исполнителям — в той же транзакции, что и переход в «отправлено»:
    // иначе поручение ушло бы, а исполнитель о нём не узнал (или наоборот).
    afterChange: async (tx, row) => {
      await notifyResolutionEvent(tx, {
        kind: "resolution.assigned",
        resolution: row,
        userIds: await assigneeIdsIn(tx, id),
        stamp: row.dispatchedAt ?? row.updatedAt,
        author: actor.name
      });
    }
  });
}

/**
 * Записывает письмо-поручение, которым поручение ушло исполнителям.
 *
 * Отдельным шагом после перехода в `sent`, потому что id письма известен только
 * после отправки: сначала захват поручения (переход), затем письмо, затем эта запись.
 * До неё поручение уже «в работе», но в журнале не видно, каким письмом оно ушло.
 *
 * ⚠️ Письмо ровно одно: второе означало бы поручение, ушедшее дважды. Повторный
 * вызов с тем же id — не ошибка (сеть/повтор запроса), с другим — отказ.
 */
export async function attachDispatchEmail(
  resolutionId: string,
  emailId: string,
  actor: Actor
): Promise<ResolutionRecord> {
  const email = (emailId ?? "").trim();
  if (!email) throw new AppError("Не указано письмо-поручение", 400, "bad_email");

  return getDocflowDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(resolutions)
      .where(eq(resolutions.id, resolutionId))
      .limit(1)
      .for("update");
    const current = rows[0];
    if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
    if (current.status !== "sent") {
      throw badState(
        "Письмо-поручение записывается только по отправленному поручению: резолюция в состоянии «" +
          current.status +
          "»"
      );
    }
    if (current.dispatchEmailId === email) return mapResolution(current);
    if (current.dispatchEmailId) {
      throw badState(
        "Письмо-поручение уже записано (" + current.dispatchEmailId + ") — второе означало бы поручение, ушедшее дважды"
      );
    }

    const ts = now();
    await tx
      .update(resolutions)
      .set({ dispatchEmailId: email, updatedAt: ts })
      .where(eq(resolutions.id, resolutionId));
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.dispatch_email",
      entityType: "resolution",
      entityId: resolutionId,
      oldValue: stringify({ dispatchEmailId: null }),
      newValue: stringify({ dispatchEmailId: email }),
      createdAt: ts
    });
    const after = await tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).limit(1);
    return mapResolution(after[0]);
  });
}

/**
 * Записывает письмо-запрос, которым поручение ушло руководителю на утверждение.
 *
 * Порядок тот же, что при отправке исполнителям: сначала захват (создание записи или
 * переход), затем письмо, затем эта запись — id письма известен только после отправки.
 * Без неё `requestEmailId` пуст, и **ответ руководителя письмом не сопоставляется
 * с поручением**: listReplyCandidates ищет кандидатов именно по этому полю.
 *
 * ⚠️ Письмо ровно одно: второе означало бы два письма руководителю по одному поручению.
 * Повторный вызов с тем же id — не ошибка (сеть/повтор запроса), с другим — отказ.
 */
export async function attachRequestEmail(
  resolutionId: string,
  emailId: string,
  actor: Actor
): Promise<ResolutionRecord> {
  const email = (emailId ?? "").trim();
  if (!email) throw new AppError("Не указано письмо-запрос", 400, "bad_email");

  return getDocflowDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(resolutions)
      .where(eq(resolutions.id, resolutionId))
      .limit(1)
      .for("update");
    const current = rows[0];
    if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
    if (current.status !== "pending_approval") {
      throw badState(
        "Письмо-запрос записывается, только пока поручение ждёт решения руководителя: резолюция в состоянии «" +
          current.status +
          "»"
      );
    }
    if (current.requestEmailId === email) return mapResolution(current);
    if (current.requestEmailId) {
      throw badState(
        "Письмо-запрос уже записано (" + current.requestEmailId + ") — второе означало бы два письма руководителю"
      );
    }

    const ts = now();
    await tx
      .update(resolutions)
      .set({ requestEmailId: email, updatedAt: ts })
      .where(eq(resolutions.id, resolutionId));

    // Шаг истории правим в той же транзакции: иначе в журнале остаётся «manual»,
    // хотя письмо ушло по почте. Берём последний шаг «requested» — более ранние
    // относятся к прежним попыткам пересылки.
    const requested = (
      await tx
        .select({ id: resolutionApprovals.id })
        .from(resolutionApprovals)
        .where(
          and(eq(resolutionApprovals.resolutionId, resolutionId), eq(resolutionApprovals.step, "requested"))
        )
        .orderBy(desc(resolutionApprovals.createdAt))
        .limit(1)
    )[0];
    if (requested) {
      await tx
        .update(resolutionApprovals)
        .set({ method: "email", emailId: email })
        .where(eq(resolutionApprovals.id, requested.id));
    }

    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.request_email",
      entityType: "resolution",
      entityId: resolutionId,
      oldValue: stringify({ requestEmailId: null }),
      newValue: stringify({ requestEmailId: email }),
      createdAt: ts
    });
    const after = await tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).limit(1);
    return mapResolution(after[0]);
  });
}

/**
 * Откат неудачной отправки: sent → approved.
 *
 * Порядок отправки: переход в sent (он же захват поручения) → письмо → `attachDispatchEmail`.
 * Если письмо отправить не удалось, оставлять поручение «в работе» нельзя: исполнители
 * его не получали, а в журнале оно выглядело бы выданным. Возвращаем в approved,
 * чтобы аппарат повторил отправку.
 *
 * ⚠️ Записанное письмо НЕ стирается: письмо могло реально уйти (сбой уже после отправки),
 * и по dispatchEmailId его находят в почте. Следующая отправка перезапишет поле новым письмом.
 *
 * ⚠️ Отчёт хотя бы одного исполнителя — стоп: работа по поручению идёт, и повторная
 * отправка была бы вторым письмом по одному и тому же поручению. Проверка идёт внутри
 * транзакции перехода (guard), иначе её обходила бы гонка с отчётом.
 *
 * «Расписки» исполнителей (receivedAt) не трогаем: это факт того, что человек документ
 * получил, — задним числом такие факты не переписываются.
 */
export async function revertDispatch(id: string, actor: Actor, reason: string): Promise<ResolutionRecord> {
  const comment = (reason ?? "").trim();
  if (!comment) throw new AppError("Укажите причину отката отправки", 400, "no_reason");

  return applyTransition(id, actor, {
    from: ["sent"],
    to: "approved",
    // Письмо (dispatchEmailId) намеренно не трогаем — см. выше.
    patch: { dispatchedBy: null, dispatchedAt: null },
    step: "dispatch_failed",
    comment,
    action: "resolution.dispatch_failed",
    guard: async (tx) => {
      const reported = await tx
        .select({ userId: resolutionAssignees.userId })
        .from(resolutionAssignees)
        .where(and(eq(resolutionAssignees.resolutionId, id), isNotNull(resolutionAssignees.reportAt)))
        .limit(1);
      if (reported.length) {
        throw badState("По поручению уже отчитался исполнитель — откат открыл бы повторную отправку");
      }
    }
  });
}

/** Отмена: ошибка обнаружилась до отправки. Отправленное не отменяем — это уже поручение. */
export async function cancelResolution(id: string, actor: Actor, comment: string): Promise<ResolutionRecord> {
  return applyTransition(id, actor, {
    from: ["draft", "pending_approval", "email_approval", "approved"],
    to: "cancelled",
    step: "cancelled",
    comment,
    action: "resolution.cancel"
  });
}
// ---------------- Списки и задачи ----------------

/** Короткое поручение по документу — для таблицы журнала. */
export interface DocumentResolutionBrief {
  text: string;
  status: string;
  deadline: string | null;
  assignees: string[];
}

/**
 * ПОСЛЕДНЕЕ поручение по каждому документу — для таблицы журнала.
 *
 * В карточке поручение было видно, а в списке журнала — нет ни резолюции, ни исполнителя,
 * ни срока (жалоба заказчика). Журнал показывает ТЕКУЩЕЕ состояние, поэтому берём последнее
 * поручение документа, а не все подряд.
 */
export async function resolutionsByDocument(
  documentIds: string[]
): Promise<Map<string, DocumentResolutionBrief>> {
  const out = new Map<string, DocumentResolutionBrief>();
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = await getDocflowDb()
    .select({
      id: resolutions.id,
      documentId: resolutions.documentId,
      text: resolutions.text,
      status: resolutions.status,
      deadline: resolutions.deadline,
      createdAt: resolutions.createdAt
    })
    .from(resolutions)
    .where(inArray(resolutions.documentId, ids))
    .orderBy(desc(resolutions.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.documentId)) latest.set(r.documentId, r);
  const assignees = await assigneesForResolutions([...latest.values()].map((r) => r.id));
  for (const [docId, r] of latest) {
    out.set(docId, {
      text: r.text,
      status: r.status,
      deadline: r.deadline,
      assignees: (assignees.get(r.id) ?? []).map((a) => a.fullName)
    });
  }
  return out;
}

export async function listResolutions(filter: ResolutionFilter = {}): Promise<ResolutionPage> {
  const db = getDocflowDb();
  const conds = [];
  if (filter.status) conds.push(eq(resolutions.status, filter.status));
  if (filter.documentId) conds.push(eq(resolutions.documentId, filter.documentId));
  if (filter.assigneeId) {
    const ids = await db
      .select({ id: resolutionAssignees.resolutionId })
      .from(resolutionAssignees)
      .where(eq(resolutionAssignees.userId, filter.assigneeId));
    const list = ids.map((r) => r.id);
    // Пустой список — заведомо ложное условие: иначе вернулись бы все резолюции.
    conds.push(list.length ? inArray(resolutions.id, list) : sql`false`);
  }
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = await db
    .select({ id: resolutions.id })
    .from(resolutions)
    .where(where)
    .orderBy(desc(resolutions.createdAt))
    .limit(limit)
    .offset(offset);
  const totalRows = await db.select({ n: countExpr }).from(resolutions).where(where);

  // Детали собираются пакетно: раньше на каждую строку приходилось по пять запросов.
  const items = await resolutionDetailsInOrder(rows.map((r) => r.id));
  return { items, total: Number(totalRows[0]?.n ?? 0) };
}

/**
 * «Мои задачи» исполнителя. Задачей становится только отправленная резолюция:
 * до отправки исполнитель о ней не знает.
 */
export async function listMyTasks(userId: string): Promise<TaskItem[]> {
  const db = getDocflowDb();
  // Порог «за N дней» — та же настройка, что и у уведомлений о сроках (А5): UI и напоминания
  // обязаны подсвечивать срок одинаково, иначе «осталось 2 дня» и молчание рядом выглядят багом.
  const dueSoonDays = await getDueSoonDays();
  const rows = await db
    .select({ a: resolutionAssignees, r: resolutions, doc: documents })
    .from(resolutionAssignees)
    .innerJoin(resolutions, eq(resolutions.id, resolutionAssignees.resolutionId))
    .innerJoin(documents, eq(documents.id, resolutions.documentId))
    .where(and(eq(resolutionAssignees.userId, userId), inArray(resolutions.status, ["sent", "done"])))
    .orderBy(asc(resolutions.deadline));

  return rows.map((r) => {
    const deadline = r.r.deadline;
    const left = daysLeft(deadline);
    return {
      resolutionId: r.r.id,
      kind: r.a.kind as AssigneeKind,
      text: r.r.text,
      priority: r.r.priority as ResolutionPriority,
      deadline,
      receivedAt: r.a.receivedAt,
      reportAt: r.a.reportAt,
      reportText: r.a.reportText,
      documentId: r.doc.id,
      documentNumber: r.doc.regNumber,
      documentSummary: r.doc.summary || r.doc.documentName,
      // Письмо, которое исполнитель ПОЛУЧИЛ (поручение), а не входящее письмо предприятия:
      // открывать в своей почте имеет смысл только то, что реально пришло на его адрес.
      emailId: r.r.dispatchEmailId,
      // Исполненная задача не бывает просроченной, даже если срок прошёл.
      overdue: r.a.reportAt === null && isOverdue(deadline),
      dueSoon: r.a.reportAt === null && left !== null && left >= 0 && left <= dueSoonDays,
      daysLeft: left
    };
  });
}

/**
 * Отметка о получении документа исполнителем — «расписка» из графы 8 журнала (О6).
 * Проставляется, когда исполнитель открыл задачу.
 *
 * ⚠️ Расписка — такая же мутация журнала, как отчёт или переход, поэтому она пишется
 * со следом в аудите и в ОДНОЙ с ним транзакции (AGENTS.md, п. 4); без этого при сбое
 * в графе 8 стояла бы отметка, а кто её поставил — неизвестно. Строка резолюции
 * берётся FOR UPDATE первой — тот же порядок, что в applyTransition, reportExecution
 * и confirmReport: иной порядок дал бы взаимную блокировку.
 */
export async function markTaskReceived(resolutionId: string, userId: string): Promise<void> {
  await getDocflowDb().transaction(async (tx) => {
    // Замок на резолюции — первым действием: он же разводит две одновременные расписки,
    // иначе обе увидели бы «ещё не получено» и написали бы по следу.
    await tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).limit(1).for("update");

    const rows = await tx
      .select()
      .from(resolutionAssignees)
      .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)))
      .limit(1);
    // Повторное открытие задачи не должно переписывать время получения:
    // важно, когда человек получил документ впервые. И второго следа быть не должно.
    const mine = rows[0];
    if (!mine || mine.receivedAt) return;

    const ts = now();
    await tx
      .update(resolutionAssignees)
      .set({ receivedAt: ts })
      .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)));

    // Расписался сам исполнитель; имя берём из справочника, чтобы след читался
    // без дополнительного запроса в интерфейсе.
    const person = (
      await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1)
    )[0];
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId,
      userName: person?.fullName ?? "",
      action: "resolution.received",
      entityType: "resolution",
      entityId: resolutionId,
      oldValue: stringify({ receivedAt: null }),
      newValue: stringify({ receivedAt: ts }),
      createdAt: ts
    });
  });
}

/**
 * Канбан руководителя (ТЗ п. 5). Колонки — состояния резолюции плюс отдельная
 * «Просрочено»: это то, на что смотрят в первую очередь.
 */
export async function listBoard(): Promise<{ key: string; title: string; items: ResolutionDetail[] }[]> {
  const page = await listResolutions({ limit: 200 });
  const columns = [
    { key: "pending_approval", title: "На утверждении", items: [] as ResolutionDetail[] },
    { key: "approved", title: "Утверждено, ждёт отправки", items: [] as ResolutionDetail[] },
    { key: "sent", title: "В работе", items: [] as ResolutionDetail[] },
    { key: "overdue", title: "Просрочено", items: [] as ResolutionDetail[] },
    { key: "done", title: "Выполнено", items: [] as ResolutionDetail[] }
  ];
  for (const item of page.items) {
    if (item.status === "email_approval") {
      columns[0].items.push(item);
      continue;
    }
    const col = columns.find((c) => c.key === item.status);
    if (col) col.items.push(item);
    if (item.status === "sent" && isOverdue(item.deadline)) columns[3].items.push(item);
  }
  return columns;
}


/**
 * Отчёт исполнителя об исполнении (этап 4).
 *
 * Правило закрытия — по Р10, и оно разное в зависимости от того, назначен ли ответственный:
 *   - есть ответственный — задачу закрывает ЕГО отчёт, отчёты соисполнителей прикладываются
 *     к тому же делу (с него спрос, и он же отвечает за результат целиком);
 *   - ответственного нет (все равны) — задача закрывается, когда отчитались ВСЕ.
 *
 * Отчёт можно дополнить: исполнитель вправе уточнить формулировку. Первый отчёт не стирается —
 * в истории остаётся, кто и когда отчитался.
 */
export interface ReportInput {
  text: string;
  /** Письмо-отчёт, если исполнитель ответил письмом, а не через приложение. */
  emailId?: string | null;
}

export async function reportExecution(
  resolutionId: string,
  userId: string,
  input: ReportInput,
  actor: Actor
): Promise<ResolutionRecord> {
  const text = (input.text ?? "").trim();
  if (!text) throw new AppError("Отчёт пуст — опишите, что сделано", 400, "empty_report");

  const db = getDocflowDb();
  const ts = now();

  // ⚠️ Проверка состояния, запись отчёта и след — ОДНА транзакция, и строка резолюции
  // берётся FOR UPDATE ПЕРВОЙ (тот же порядок, что в applyTransition: разный порядок
  // дал бы взаимную блокировку). Иначе guard отката отправки читает отчёт, которого в
  // его снапшоте ещё нет: откат проходит, а отчёт коммитится следом — поручение
  // «утверждено» с уже отчитавшимся исполнителем, повторная отправка даёт второе письмо.
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).limit(1).for("update");
    const current = rows[0];
    if (!current) throw new AppError("Резолюция не найдена", 404, "not_found");
    // Отчитаться можно только по выданному поручению: до отправки исполнитель о нём
    // не знает, после закрытия — отчёт уже не имеет смысла (поправить может аппарат).
    if (current.status !== "sent") {
      throw badState(
        current.status === "done"
          ? "Поручение уже исполнено"
          : "Поручение ещё не отправлено исполнителям"
      );
    }

    const mine = (
      await tx
        .select()
        .from(resolutionAssignees)
        .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)))
        .limit(1)
    )[0];
    if (!mine) throw new AppError("Вы не исполнитель по этому поручению", 403, "not_assignee");

    await tx
      .update(resolutionAssignees)
      .set({ reportText: text, reportAt: ts, reportEmailId: input.emailId ?? null })
      .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)));
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.report",
      entityType: "resolution",
      entityId: resolutionId,
      newValue: stringify({ text, emailId: input.emailId ?? null }),
      createdAt: ts
    });
    // Отчёт записан — аппарат и подписант узнают об этом в той же транзакции (§3).
    await notifyResolutionEvent(tx, {
      kind: "resolution.reported",
      resolution: current,
      userIds: [current.preparedBy, current.approvedBy],
      stamp: ts,
      author: actor.name
    });
  });

  return applyClosingRule(resolutionId, actor);
}

/**
 * Правило закрытия (Р10): есть ответственный — закрывает его отчёт, нет — когда отчитались все.
 *
 * Вынесено отдельно, потому что закрыть поручение можно двумя путями: отчётом в приложении
 * и подтверждением отчёта, пришедшего письмом.
 */
async function applyClosingRule(resolutionId: string, actor: Actor): Promise<ResolutionRecord> {
  const all = await listResolutionAssignees(resolutionId);
  const withReport = all.filter((a) => a.reportAt);
  const responsible = all.find((a) => a.kind === "responsible");
  const shouldClose = responsible ? !!responsible.reportAt : withReport.length === all.length;

  if (shouldClose) {
    return applyTransition(resolutionId, actor, {
      from: ["sent"],
      to: "done",
      step: "dispatched",
      comment: responsible
        ? "Исполнено: отчитался ответственный " + (responsible.fullName || "")
        : "Исполнено: отчитались все исполнители",
      action: "resolution.done",
      // Автоматическое закрытие — тоже закрытие: иначе о нём узнали бы только те,
      // кто открыл карточку, а «Поручение исполнено» так и не пришло бы.
      afterChange: (tx, row) => notifyClosed(tx, row, actor)
    });
  }
  return (await getResolution(resolutionId))!;
}



/**
 * Письмо, на которое мог быть дан ответ: поручение ждёт утверждения или исполнения.
 *
 * ⚠️ Это **не решение**, а материал для подсказки. Система не определяет, чем является письмо —
 * это отмечает аппарат, открыв письмо в почте. Здесь только кандидаты по треду.
 */
export interface ThreadReplyCandidate {
  resolutionId: string;
  /** Чего ждёт поручение: утверждения руководителя или отчёта исполнителя. */
  expects: "approval" | "report";
  /** Письмо, на которое отвечали: по нему сопоставляем тред. */
  emailId: string;
  documentNumber: string;
  documentSummary: string;
  taskText: string;
  /** Исполнители — чтобы подсказать, от кого ждём отчёт. */
  assignees: Array<{ userId: string; fullName: string; kind: AssigneeKind }>;
}

export async function listReplyCandidates(): Promise<ThreadReplyCandidate[]> {
  const db = getDocflowDb();
  const rows = await db
    .select({ r: resolutions, doc: documents })
    .from(resolutions)
    .leftJoin(documents, eq(documents.id, resolutions.documentId))
    // `email_approval` тоже берём: поручение могло остаться в этом состоянии (старые данные
    // или прерванная разметка), и тогда его нечем было бы отметить повторно.
    .where(inArray(resolutions.status, ["pending_approval", "email_approval", "sent"]));

  const candidates = rows
    .map((x) => {
      const approval = x.r.status === "pending_approval" || x.r.status === "email_approval";
      return {
        x,
        approval,
        emailId: (approval ? x.r.requestEmailId : x.r.dispatchEmailId) as string | null
      };
    })
    // Без письма сопоставлять нечего: поручение завели в приложении, ответа письмом не ждём.
    .filter((c) => !!c.emailId);

  // Исполнители — одним запросом на весь список, а не по одному на строку.
  const assignees = await assigneesForResolutions(candidates.map((c) => c.x.r.id));

  return candidates.map((c) => ({
    resolutionId: c.x.r.id,
    expects: c.approval ? "approval" : "report",
    emailId: c.emailId as string,
    documentNumber: c.x.doc?.regNumber ?? "",
    documentSummary: c.x.doc?.summary || c.x.doc?.documentName || "",
    taskText: c.x.r.text,
    assignees: (assignees.get(c.x.r.id) ?? []).map((a) => ({ userId: a.userId, fullName: a.fullName, kind: a.kind }))
  }));
}

/**
 * Поручения, ждущие отчёта по письму: отправленные, с сохранённым письмом-поручением.
 *
 * Возвращаем `dispatchEmailId`: по нему вызывающий код найдёт Message-ID письма и сопоставит
 * ответ исполнителя по треду (та же механика, что у ответа руководителя).
 */
export async function listAwaitingReports(): Promise<
  Array<{ resolutionId: string; dispatchEmailId: string; taskText: string; documentNumber: string }>
> {
  const rows = await getDocflowDb()
    .select({
      id: resolutions.id,
      dispatchEmailId: resolutions.dispatchEmailId,
      text: resolutions.text,
      regNumber: documents.regNumber
    })
    .from(resolutions)
    .leftJoin(documents, eq(documents.id, resolutions.documentId))
    .where(and(eq(resolutions.status, "sent"), isNotNull(resolutions.dispatchEmailId)));
  return rows
    .filter((r) => !!r.dispatchEmailId)
    .map((r) => ({
      resolutionId: r.id,
      dispatchEmailId: r.dispatchEmailId as string,
      taskText: r.text,
      documentNumber: r.regNumber ?? ""
    }));
}

/**
 * Аппарат подтверждает распознанный отчёт: текст можно поправить — дальше срабатывает
 * правило закрытия. Подтверждение и есть акт приёмки исполнения.
 */
export async function confirmReport(
  resolutionId: string,
  userId: string,
  input: { text?: string; emailId?: string | null },
  actor: Actor
): Promise<ResolutionRecord> {
  const db = getDocflowDb();
  const ts = now();

  // ⚠️ Проверки и запись отчёта — ОДНА транзакция, и строка резолюции берётся FOR UPDATE
  // ПЕРВОЙ (тот же порядок, что в applyTransition: иначе взаимная блокировка). Иначе
  // guard отката отправки не видит ещё не закоммиченный принятый отчёт: откат проходит,
  // а отчёт коммитится следом — поручение «утверждено» с уже отчитавшимся исполнителем.
  await db.transaction(async (tx) => {
    const locked = (
      await tx.select().from(resolutions).where(eq(resolutions.id, resolutionId)).limit(1).for("update")
    )[0];

    const mine = (
      await tx
        .select()
        .from(resolutionAssignees)
        .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)))
        .limit(1)
    )[0];
    if (!mine) throw new AppError("Исполнитель не найден в поручении", 404, "not_found");
    if (mine.reportAt) throw badState("Отчёт уже принят");
    // Предложение модели может отсутствовать: аппарат отмечает отчёт, открыв письмо в почте.
    // Требовать «распознанного» отчёта нельзя — тогда ручной путь был бы закрыт.
    const text = (input.text ?? mine.reportSummary ?? "").trim();
    if (!text) throw new AppError("Текст отчёта пуст", 400, "empty_report");

    if (!locked || locked.status !== "sent") throw badState("Поручение не в работе");

    await tx
      .update(resolutionAssignees)
      .set({ reportText: text, reportAt: ts })
      .where(and(eq(resolutionAssignees.resolutionId, resolutionId), eq(resolutionAssignees.userId, userId)));
    await tx.insert(auditLog).values({
      id: randomUUID(),
      userId: actor.id,
      userName: actor.name,
      action: "resolution.report_confirmed",
      entityType: "resolution",
      entityId: resolutionId,
      oldValue: stringify({ summary: mine.reportSummary }),
      newValue: stringify({ text, executorId: userId, emailId: input.emailId ?? null }),
      createdAt: ts
    });
  });

  return applyClosingRule(resolutionId, actor);
}

/**
 * Закрытие поручения аппаратом — когда исполнитель отчитался не в приложении
 * (письмом или лично), и отчёт вводить вручную не нужно.
 */
export async function closeResolution(
  id: string,
  actor: Actor,
  comment: string
): Promise<ResolutionRecord> {
  return applyTransition(id, actor, {
    from: ["sent"],
    to: "done",
    step: "dispatched",
    comment,
    action: "resolution.done",
    afterChange: (tx, row) => notifyClosed(tx, row, actor)
  });
}

/** Резолюции документа — для карточки документа в журнале. */
export async function listDocumentResolutions(documentId: string): Promise<ResolutionDetail[]> {
  const page = await listResolutions({ documentId, limit: 200 });
  return page.items;
}