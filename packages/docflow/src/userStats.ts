/**
 * Агрегат «профиль исполнителя» (task-18): данные под БУДУЩУЮ подсказку исполнителей.
 *
 * ⚠️ Сама подсказка НЕ реализована: граф знаний и MCP — после 0.1.4. Здесь только сбор
 * производных данных, на которых её потом можно построить: сколько писем и поручений
 * приходило человеку, по месяцам, от каких организаций, с какими тегами и категориями,
 * сколько времени занимало исполнение и кто ему поручает.
 *
 * Свойства, ради которых модуль так устроен:
 *   • источник НЕ перезаписывается: только SELECT из сырых таблиц, запись — в две новые;
 *   • пересчёт ИДЕМПОТЕНТЕН: строка на пользователя (и на месяц) заменяется целиком
 *     в одной транзакции, уникальные ключи не дают удвоиться;
 *   • `raw_fingerprint` даёт пропуск: если сырые данные не изменились, не переписываем НИЧЕГО;
 *   • приватность: только счётчики и топы (названия организаций, имена авторов, теги) —
 *     ни текстов писем, ни адресов, ни переписки.
 *
 * Теги и категории живут в ПОЧТОВОЙ базе (core), а docflow в core не ходит (зависимость
 * строго односторонняя). Поэтому объявлен провайдер, который регистрирует композиционный
 * корень: `setUserStatsMailFactsProvider` — тот же приём, что у ldapSettingsStore.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "@mailsense/core/directory";
import { getDocflowDb, getDocflowPool } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { daysLeft } from "./deadlines.js";

const { userActivityStats, userActivityStatsMonthly } = docflowSchema;

/** Сколько значений в топах: короткое описание профиля, а не выгрузка. */
const TOP = 10;
const TOP_MONTHLY = 5;

export interface MailFacts {
  tags: string[];
  categories: string[];
}

/** Провайдер фактов почты: список emailId → карта «письмо → теги/категории». Read-only. */
export type MailFactsProvider = (
  emailIds: string[]
) => Promise<Map<string, MailFacts>> | Map<string, MailFacts>;

let mailFactsProvider: MailFactsProvider | null = null;

export function setUserStatsMailFactsProvider(provider: MailFactsProvider | null): void {
  mailFactsProvider = provider;
}

export interface CountedValue {
  value: string;
  count: number;
}

export interface UserActivityStatsMonthlyView {
  period: string;
  documentsRegistered: number;
  tasksAssigned: number;
  tasksReported: number;
  /** Организации-корреспонденты: имя организации, а не «значение» тега. */
  correspondenceOrgs: Array<{ name: string; count: number }>;
  topTags: CountedValue[];
  topCategories: CountedValue[];
}

export interface UserActivityStatsView {
  userId: string;
  fullName: string;
  department: string;
  documentsRegistered: number;
  tasksAssigned: number;
  tasksReported: number;
  tasksOpen: number;
  tasksOverdue: number;
  resolutionsPrepared: number;
  resolutionsApproved: number;
  resolutionsDispatched: number;
  avgExecutionDays: number | null;
  correspondenceOrgs: Array<{ name: string; count: number }>;
  topTags: CountedValue[];
  topCategories: CountedValue[];
  requestDepartments: Array<{ department: string; count: number }>;
  authors: Array<{ userId: string; name: string; count: number }>;
  months: UserActivityStatsMonthlyView[];
  computedAt: string;
}

export interface RecomputeResult {
  /** Сколько пользователей рассмотрено. */
  users: number;
  /** Сколько строк реально пересчитано и перезаписано. */
  updated: number;
  /** Сколько пропущено: отпечаток сырых данных не изменился. */
  skipped: number;
  /** Сколько месячных строк записано. */
  monthly: number;
}

function topCounts(map: Map<string, number>, limit: number): CountedValue[] {
  return [...map.entries()]
    // Порядок детерминирован: сначала по числу, затем по значению — иначе «топ» прыгает
    // между пересчётами и отпечаток не совпадает сам с собой.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function monthOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})/.exec(value.trim());
  return m ? m[1] + "-" + m[2] : null;
}

function bump(map: Map<string, number>, key: string | null | undefined, by = 1): void {
  const value = (key ?? "").trim();
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + by);
}

interface RawTaskRow {
  user_id: string;
  resolution_id: string;
  document_id: string;
  status: string;
  deadline: string | null;
  dispatched_at: string | null;
  report_at: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  sender: string | null;
  email_id: string | null;
  task_at: string | null;
}

interface RawDocRow {
  id: string;
  user_id: string | null;
  reg_date: string;
  sender: string | null;
  email_id: string | null;
}

interface UserRow {
  id: string;
  full_name: string;
  department: string;
}

function fingerprintOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Кого пересчитываем: по списку — как просили; иначе только тех, у кого есть связь. */
async function resolveTargetUsers(userIds?: string[]): Promise<string[]> {
  const pool = getDocflowPool();
  if (userIds) {
    const wanted = [...new Set(userIds.map((v) => String(v ?? "").trim()).filter(Boolean))];
    if (wanted.length === 0) return [];
    const rows = await pool.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1)", [wanted]);
    return rows.rows.map((r) => r.id);
  }
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM documents d WHERE d.created_by = u.id) " +
      "OR EXISTS (SELECT 1 FROM resolution_assignees a WHERE a.user_id = u.id) " +
      "OR EXISTS (SELECT 1 FROM resolutions r WHERE r.prepared_by = u.id OR r.approved_by = u.id OR r.dispatched_by = u.id)"
  );
  return rows.rows.map((r) => r.id);
}

/**
 * Пересчитывает агрегат.
 *
 * @param opts.userIds — конкретные пользователи; без него — все, у кого есть активность.
 */
export async function recomputeUserStats(opts: { userIds?: string[] } = {}): Promise<RecomputeResult> {
  const targets = await resolveTargetUsers(opts.userIds);
  if (targets.length === 0) return { users: 0, updated: 0, skipped: 0, monthly: 0 };

  const pool = getDocflowPool();
  const db = getDocflowDb();

  const [docs, tasks, users, roleRows]: [
    { rows: RawDocRow[] },
    { rows: RawTaskRow[] },
    { rows: UserRow[] },
    { rows: Array<{ prepared_by: string | null; approved_by: string | null; dispatched_by: string | null }> }
  ] = await Promise.all([
    pool.query<RawDocRow>(
      // Берём и письма самого пользователя, и письма его поручений: иначе у исполнителя
      // «от кого приходят письма» было бы пусто.
      "SELECT d.id, d.created_by AS user_id, d.reg_date, d.sender, d.email_id FROM documents d " +
        "WHERE d.created_by = ANY($1) OR d.id IN (" +
        "SELECT r.document_id FROM resolutions r JOIN resolution_assignees a ON a.resolution_id = r.id " +
        "WHERE a.user_id = ANY($1))",
      [targets]
    ),
    pool.query<RawTaskRow>(
      "SELECT a.user_id, r.id AS resolution_id, r.document_id, r.status, r.deadline, r.dispatched_at, a.report_at, " +
        "r.prepared_by, r.approved_by, d.sender, d.email_id, " +
        "COALESCE(r.dispatched_at, r.created_at) AS task_at " +
        "FROM resolution_assignees a JOIN resolutions r ON r.id = a.resolution_id " +
        "LEFT JOIN documents d ON d.id = r.document_id WHERE a.user_id = ANY($1)",
      [targets]
    ),
    pool.query<UserRow>("SELECT id, full_name, department FROM users"),
    pool.query<{ prepared_by: string | null; approved_by: string | null; dispatched_by: string | null }>(
      "SELECT prepared_by, approved_by, dispatched_by FROM resolutions " +
        "WHERE prepared_by = ANY($1) OR approved_by = ANY($1) OR dispatched_by = ANY($1)",
      [targets]
    )
  ]);

  const userById = new Map(users.rows.map((u) => [u.id, u]));

  // Факты почты — ОДНИМ пакетным вызовом на весь пересчёт; ошибка провайдера не роняет
  // работу: теги просто останутся пустыми (иначе недоступность почты ломала бы агрегат).
  const emailIds = [
    ...new Set([...docs.rows, ...tasks.rows].map((r) => r.email_id).filter((v): v is string => !!v))
  ];
  let facts = new Map<string, MailFacts>();
  if (mailFactsProvider && emailIds.length > 0) {
    try {
      facts = await mailFactsProvider(emailIds);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, emails: emailIds.length },
        "Провайдер фактов почты недоступен — теги и категории в агрегат не попадут"
      );
      facts = new Map();
    }
  }

  const docById = new Map<string, RawDocRow>();
  for (const row of docs.rows) docById.set(row.id, row);
  // Письма, ЗАРЕГИСТРИРОВАННЫЕ пользователем (для счётчика documentsRegistered и месяцев).
  const registeredByUser = new Map<string, RawDocRow[]>();
  for (const row of docs.rows) {
    if (!row.user_id) continue;
    const list = registeredByUser.get(row.user_id) ?? [];
    list.push(row);
    registeredByUser.set(row.user_id, list);
  }
  const tasksByUser = new Map<string, RawTaskRow[]>();
  for (const row of tasks.rows) {
    const list = tasksByUser.get(row.user_id) ?? [];
    list.push(row);
    tasksByUser.set(row.user_id, list);
  }
  const rolesByUser = new Map<string, { prepared: number; approved: number; dispatched: number }>();
  for (const row of roleRows.rows) {
    for (const [field, key] of [
      [row.prepared_by, "prepared"],
      [row.approved_by, "approved"],
      [row.dispatched_by, "dispatched"]
    ] as const) {
      if (!field || !targets.includes(field)) continue;
      const acc = rolesByUser.get(field) ?? { prepared: 0, approved: 0, dispatched: 0 };
      acc[key] += 1;
      rolesByUser.set(field, acc);
    }
  }

  let updated = 0;
  let skipped = 0;
  let monthlyWritten = 0;

  for (const userId of targets) {
    const user = userById.get(userId);
    const myRegistered = registeredByUser.get(userId) ?? [];
    const myTasks = tasksByUser.get(userId) ?? [];
    // Письма пользователя БЕЗ дублей: одно письмо считается один раз, сколько бы поручений
    // по нему ни было — иначе топы раздувались бы от числа поручений, а не от почты.
    const inScope = new Map<string, RawDocRow>();
    for (const doc of myRegistered) inScope.set(doc.id, doc);
    for (const task of myTasks) {
      const doc = docById.get(task.document_id);
      if (doc && !inScope.has(doc.id)) inScope.set(doc.id, doc);
    }
    const roles = rolesByUser.get(userId) ?? { prepared: 0, approved: 0, dispatched: 0 };

    const senderTotals = new Map<string, number>();
    const tagsTotals = new Map<string, number>();
    const categoryTotals = new Map<string, number>();
    const authorTotals = new Map<string, number>();
    const departmentTotals = new Map<string, number>();
    const months = new Map<string, UserActivityStatsMonthlyView & { _senders: Map<string, number>; _tags: Map<string, number>; _cats: Map<string, number> }>();

    const monthBucket = (period: string) => {
      const existing = months.get(period);
      if (existing) return existing;
      const fresh = {
        period,
        documentsRegistered: 0,
        tasksAssigned: 0,
        tasksReported: 0,
        correspondenceOrgs: [] as Array<{ name: string; count: number }>,
        topTags: [] as CountedValue[],
        topCategories: [] as CountedValue[],
        _senders: new Map<string, number>(),
        _tags: new Map<string, number>(),
        _cats: new Map<string, number>()
      };
      months.set(period, fresh);
      return fresh;
    };

    for (const doc of myRegistered) {
      const period = monthOf(doc.reg_date);
      if (period) monthBucket(period).documentsRegistered += 1;
    }

    // Корреспонденты и теги — по уникальным письмам; месяц берём по дате регистрации письма.
    for (const doc of inScope.values()) {
      const period = monthOf(doc.reg_date);
      const bucket = period ? monthBucket(period) : null;
      bump(senderTotals, doc.sender);
      if (bucket) bump(bucket._senders, doc.sender);
      const f = doc.email_id ? facts.get(doc.email_id) : undefined;
      for (const tag of f?.tags ?? []) {
        bump(tagsTotals, tag);
        if (bucket) bump(bucket._tags, tag);
      }
      for (const cat of f?.categories ?? []) {
        bump(categoryTotals, cat);
        if (bucket) bump(bucket._cats, cat);
      }
    }

    let reported = 0;
    let open = 0;
    let overdue = 0;
    const durations: number[] = [];
    const seenAuthorsPerResolution = new Set<string>();

    for (const task of myTasks) {
      const period = monthOf(task.task_at);
      if (period) monthBucket(period).tasksAssigned += 1;

      if (task.report_at) {
        reported += 1;
        if (period) monthBucket(period).tasksReported += 1;
        if (task.dispatched_at) {
          const ms = Date.parse(task.report_at) - Date.parse(task.dispatched_at);
          if (Number.isFinite(ms) && ms >= 0) durations.push(ms / 86_400_000);
        }
      } else if (task.status === "sent") {
        open += 1;
        // Просрочка — по календарным дням (та же семантика, что в «Моих задачах»).
        if (daysLeft(task.deadline) !== null && (daysLeft(task.deadline) as number) < 0) overdue += 1;
      }


      // Автор поручения — один раз на поручение, даже если он и подготовил, и утвердил.
      const authorId = task.prepared_by ?? task.approved_by;
      if (authorId && !seenAuthorsPerResolution.has(task.resolution_id)) {
        seenAuthorsPerResolution.add(task.resolution_id);
        bump(authorTotals, authorId);
        bump(departmentTotals, userById.get(authorId)?.department ?? "");
      }
    }

    const payload = {
      documentsRegistered: myRegistered.length,
      tasksAssigned: myTasks.length,
      tasksReported: reported,
      tasksOpen: open,
      tasksOverdue: overdue,
      resolutionsPrepared: roles.prepared,
      resolutionsApproved: roles.approved,
      resolutionsDispatched: roles.dispatched,
      avgExecutionDays: durations.length
        ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2))
        : null,
      correspondenceOrgs: topCounts(senderTotals, TOP).map((t) => ({ name: t.value, count: t.count })),
      topTags: topCounts(tagsTotals, TOP),
      topCategories: topCounts(categoryTotals, TOP),
      requestDepartments: topCounts(departmentTotals, TOP).map((t) => ({ department: t.value, count: t.count })),
      authors: topCounts(authorTotals, TOP).map((t) => ({
        userId: t.value,
        name: userById.get(t.value)?.full_name ?? "",
        count: t.count
      })),
      months: [...months.values()]
        .sort((a, b) => a.period.localeCompare(b.period))
        .map((m) => ({
          period: m.period,
          documentsRegistered: m.documentsRegistered,
          tasksAssigned: m.tasksAssigned,
          tasksReported: m.tasksReported,
          correspondenceOrgs: topCounts(m._senders, TOP_MONTHLY).map((t) => ({ name: t.value, count: t.count })),
          topTags: topCounts(m._tags, TOP_MONTHLY),
          topCategories: topCounts(m._cats, TOP_MONTHLY)
        }))
    };

    const fingerprint = fingerprintOf(payload);
    const existing = await pool.query<{ raw_fingerprint: string }>(
      "SELECT raw_fingerprint FROM user_activity_stats WHERE user_id = $1",
      [userId]
    );
    if (existing.rows[0]?.raw_fingerprint === fingerprint) {
      // Сырые данные не изменились — не переписываем ни строки (и computed_at не трогаем).
      skipped += 1;
      continue;
    }

    const computedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(userActivityStats).where(eq(userActivityStats.userId, userId));
      await tx.insert(userActivityStats).values({
        userId,
        documentsRegistered: payload.documentsRegistered,
        tasksAssigned: payload.tasksAssigned,
        tasksReported: payload.tasksReported,
        tasksOpen: payload.tasksOpen,
        tasksOverdue: payload.tasksOverdue,
        resolutionsPrepared: payload.resolutionsPrepared,
        resolutionsApproved: payload.resolutionsApproved,
        resolutionsDispatched: payload.resolutionsDispatched,
        avgExecutionDays: payload.avgExecutionDays,
        correspondenceOrgs: payload.correspondenceOrgs,
        topTags: payload.topTags,
        topCategories: payload.topCategories,
        requestDepartments: payload.requestDepartments,
        authors: payload.authors,
        rawFingerprint: fingerprint,
        computedAt
      });
      await tx.delete(userActivityStatsMonthly).where(eq(userActivityStatsMonthly.userId, userId));
      if (payload.months.length) {
        await tx.insert(userActivityStatsMonthly).values(
          payload.months.map((m) => ({
            userId,
            period: m.period,
            documentsRegistered: m.documentsRegistered,
            tasksAssigned: m.tasksAssigned,
            tasksReported: m.tasksReported,
            correspondenceOrgs: m.correspondenceOrgs,
            topTags: m.topTags,
            topCategories: m.topCategories,
            computedAt
          }))
        );
      }
    });
    updated += 1;
    monthlyWritten += payload.months.length;
  }

  return { users: targets.length, updated, skipped, monthly: monthlyWritten };
}

/** Служебное чтение агрегата: только администратор (маршрут под settings.manage). */
export async function listUserActivityStats(
  opts: { userId?: string; limit?: number } = {}
): Promise<{ items: UserActivityStatsView[]; total: number; computedAt: string | null }> {
  const db = getDocflowDb();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const where = opts.userId ? eq(userActivityStats.userId, opts.userId) : undefined;

  const rows = await db.select().from(userActivityStats).where(where).orderBy(desc(userActivityStats.computedAt)).limit(limit);
  const totals = await db.select({ n: sql<number>`count(*)::int` }).from(userActivityStats).where(where);
  const monthly = rows.length
    ? await db
        .select()
        .from(userActivityStatsMonthly)
        .where(inArray(userActivityStatsMonthly.userId, rows.map((r) => r.userId)))
        .orderBy(userActivityStatsMonthly.period)
    : [];

  const monthlyByUser = new Map<string, UserActivityStatsMonthlyView[]>();
  for (const m of monthly) {
    const list = monthlyByUser.get(m.userId) ?? [];
    list.push({
      period: m.period,
      documentsRegistered: m.documentsRegistered,
      tasksAssigned: m.tasksAssigned,
      tasksReported: m.tasksReported,
      correspondenceOrgs: m.correspondenceOrgs,
      topTags: m.topTags,
      topCategories: m.topCategories
    });
    monthlyByUser.set(m.userId, list);
  }

  const userRows = rows.length
    ? await db
        .select({ id: docflowSchema.users.id, fullName: docflowSchema.users.fullName, department: docflowSchema.users.department })
        .from(docflowSchema.users)
        .where(inArray(docflowSchema.users.id, rows.map((r) => r.userId)))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  return {
    items: rows.map((r) => ({
      userId: r.userId,
      fullName: userById.get(r.userId)?.fullName ?? "",
      department: userById.get(r.userId)?.department ?? "",
      documentsRegistered: r.documentsRegistered,
      tasksAssigned: r.tasksAssigned,
      tasksReported: r.tasksReported,
      tasksOpen: r.tasksOpen,
      tasksOverdue: r.tasksOverdue,
      resolutionsPrepared: r.resolutionsPrepared,
      resolutionsApproved: r.resolutionsApproved,
      resolutionsDispatched: r.resolutionsDispatched,
      avgExecutionDays: r.avgExecutionDays ?? null,
      correspondenceOrgs: r.correspondenceOrgs,
      topTags: r.topTags,
      topCategories: r.topCategories,
      requestDepartments: r.requestDepartments,
      authors: r.authors,
      months: monthlyByUser.get(r.userId) ?? [],
      computedAt: r.computedAt instanceof Date ? r.computedAt.toISOString() : String(r.computedAt)
    })),
    total: Number(totals[0]?.n ?? 0),
    computedAt: rows[0]
      ? rows[0].computedAt instanceof Date
        ? rows[0].computedAt.toISOString()
        : String(rows[0].computedAt)
      : null
  };
}
