/**
 * Уведомления (этап 5, §3–§4 контракта и приложение А).
 *
 * Уведомления живут ТОЛЬКО внутри приложения (решение Р11): писем-напоминаний не отправляем.
 * Материализация сроков детерминированная и считается на чтении — без cron, без фоновых задач.
 *
 * Свойства, ради которых модуль так устроен:
 *   • событийное уведомление пишется В ТОЙ ЖЕ транзакции, что и изменение (notifyInTx);
 *   • повторная материализация не плодит дубли: dedupe_key уникален в пределах пользователя;
 *   • чужое уведомление недоступно на УРОВНЕ ДАННЫХ: каждый запрос фильтрует по user_id;
 *   • ошибка материализации не роняет чтение (materializeDeadlineNotificationsSafe).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "@mailsense/core/directory";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import type { DocflowExecutor } from "./repo.js";
import { auditInTx } from "./audit.js";
import { AppError } from "./errors.js";
import { daysLeft } from "./deadlines.js";
import type { Actor } from "./journal.js";
import type {
  AppNotification,
  NotificationLink,
  NotificationPage,
  NotificationSettingsView,
  NotificationSeverity,
  NotificationTemplate
} from "./types.js";

const { notifications, notificationTemplates, settings, resolutions, resolutionAssignees, documents } = docflowSchema;

/** Виды уведомлений — заморожены контрактом §3. Порядок стабилен: по нему сеются шаблоны. */
export const NOTIFICATION_KINDS = [
  "resolution.assigned",
  "resolution.approved",
  "resolution.reported",
  "resolution.closed",
  "resolution.due_soon",
  "resolution.due_today",
  "resolution.overdue",
  "resolution.overdue_escalation"
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Уровень важности по виду уведомления (§3): danger — просрочка, warning — срок. */
export const NOTIFICATION_SEVERITY: Record<NotificationKind, NotificationSeverity> = {
  "resolution.assigned": "info",
  "resolution.approved": "info",
  "resolution.reported": "info",
  "resolution.closed": "info",
  "resolution.due_soon": "warning",
  "resolution.due_today": "warning",
  "resolution.overdue": "danger",
  "resolution.overdue_escalation": "danger"
};

/** Раздел интерфейса, куда ведёт уведомление (§7). Строку превращает в маршрут клиент. */
const LINK_BY_KIND: Record<NotificationKind, NotificationLink> = {
  "resolution.assigned": "tasks",
  "resolution.approved": "board",
  "resolution.reported": "confirmation",
  "resolution.closed": "journal",
  "resolution.due_soon": "tasks",
  "resolution.due_today": "tasks",
  "resolution.overdue": "tasks",
  "resolution.overdue_escalation": "board"
};

/**
 * Заголовок-«страховка» на случай, если строку шаблона удалили руками.
 *
 * Уведомление — не письмо: его нельзя потерять молча. Таблица шаблонов правится
 * администратором (текст, вкл/выкл), но не удаляется; пропавшая строка — это порча
 * данных, и тогда лучше показать служебный заголовок, чем не показать ничего.
 */
const FALLBACK_TITLES: Record<NotificationKind, string> = {
  "resolution.assigned": "Новое поручение",
  "resolution.approved": "Резолюция утверждена",
  "resolution.reported": "Отчёт по поручению",
  "resolution.closed": "Поручение исполнено",
  "resolution.due_soon": "Срок скоро",
  "resolution.due_today": "Срок сегодня",
  "resolution.overdue": "Просрочено",
  "resolution.overdue_escalation": "Просрочено у исполнителя"
};

export const NOTIFICATION_SETTING_KEYS = {
  enabled: "notifications.enabled",
  dueSoonDays: "notifications.dueSoonDays",
  workdayDeadlines: "notifications.workdayDeadlines"
} as const;

/** Праздники (нерабочие дни) в рабочих днях типового срока — приложение А3. */
export const DEADLINES_HOLIDAYS_KEY = "deadlines.holidays";

export const DEFAULT_DUE_SOON_DAYS = 3;
export const MAX_DUE_SOON_DAYS = 30;
/** Предел хранения: держим последние 500 уведомлений пользователя (§3). */
export const NOTIFICATION_RETENTION = 500;
export const MAX_HOLIDAYS = 100;

/**
 * Переменные шаблона — замороженный список (приложение А2). Отдаётся в настройках,
 * чтобы администратор видел, что именно можно подставить, а не угадывал имена.
 */
export const NOTIFICATION_VARIABLES: Array<{ key: string; title: string }> = [
  { key: "regNumber", title: "Номер документа" },
  { key: "summary", title: "Краткое содержание" },
  { key: "sender", title: "От кого получен" },
  { key: "deadline", title: "Срок" },
  { key: "daysLeft", title: "Дней до срока" },
  { key: "text", title: "Текст поручения" },
  { key: "author", title: "Автор" }
];

const countExpr = sql<number>`count(*)::int`;

function executor(exec?: DocflowExecutor): DocflowExecutor {
  return exec ?? getDocflowDb();
}

/** ISO-строка из даты драйвера: pg отдаёт timestamptz как Date. */
function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function notificationLink(kind: string): NotificationLink {
  return LINK_BY_KIND[kind as NotificationKind] ?? null;
}

export function notificationSeverity(kind: string): NotificationSeverity {
  return NOTIFICATION_SEVERITY[kind as NotificationKind] ?? "info";
}

// ---------------- Чтение настроек (§4) ----------------

/** Булево из базы: мусор не ломает чтение — возвращаем значение по умолчанию. */
export function parseSettingBoolean(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "да", "yes", "on"].includes(v)) return true;
  if (["false", "0", "нет", "no", "off"].includes(v)) return false;
  return fallback;
}

/** «За N дней»: целое 0..30. Мусор — значение по умолчанию, выход за границы — граница. */
export function parseDueSoonDays(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_DUE_SOON_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DUE_SOON_DAYS;
  const int = Math.trunc(n);
  if (int < 0) return 0;
  if (int > MAX_DUE_SOON_DAYS) return MAX_DUE_SOON_DAYS;
  return int;
}

/**
 * Существует ли дата на самом деле.
 *
 * ⚠️ Одной регулярки мало: `Date.parse("2026-02-30T00:00:00Z")` в V8 НЕ даёт NaN,
 * а переносит день — 30 февраля превращается в 2 марта, 31 апреля в 1 мая. Такая дата
 * прошла бы проверку формата и попала в настройку, а ядро (workingDays.parseDay) на ней
 * бросает RangeError — расчёт срока сломался бы из-за опечатки в справочнике.
 * Поэтому сверяем «туда и обратно»: разобранная дата обязана отформатироваться в исходную.
 */
function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ts = Date.parse(value + "T00:00:00Z");
  if (Number.isNaN(ts)) return false;
  return new Date(ts).toISOString().slice(0, 10) === value;
}

/**
 * Праздники из базы (JSON-массив ГГГГ-ММ-ДД). Битый JSON, мусор или несуществующая дата —
 * дата отбрасывается: типовой срок посчитается без неё, но чтение настроек не упадёт
 * и расчёт не получит RangeError.
 */
export function parseHolidays(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === "string" && isRealDay(v.trim()))
    .map((v) => v.trim())
    .slice(0, MAX_HOLIDAYS);
}

/** Праздники из тела запроса: не больше 100 дат, формат и существование проверяются (иначе 400). */
export function validateHolidays(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new AppError("Праздники должны быть списком дат", 400, "bad_holidays");
  if (list.length > MAX_HOLIDAYS) {
    throw new AppError("Слишком много праздников: не больше " + MAX_HOLIDAYS, 400, "bad_holidays");
  }
  const out: string[] = [];
  for (const item of list) {
    const value = String(item ?? "").trim();
    if (!isRealDay(value)) {
      throw new AppError(
        "Дата праздника должна существовать и быть в виде ГГГГ-ММ-ДД: " + value,
        400,
        "bad_holidays"
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.sort();
}

async function readSettingsMap(exec?: DocflowExecutor): Promise<Map<string, string>> {
  const rows = await executor(exec).select().from(settings);
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Включены ли уведомления целиком (§4). */
export async function notificationsEnabled(exec?: DocflowExecutor): Promise<boolean> {
  const map = await readSettingsMap(exec);
  return parseSettingBoolean(map.get(NOTIFICATION_SETTING_KEYS.enabled) ?? null, true);
}

/** Порог «за N дней» — нужен и «Моим задачам» (dueSoon), и материализации сроков. */
export async function getDueSoonDays(exec?: DocflowExecutor): Promise<number> {
  const map = await readSettingsMap(exec);
  return parseDueSoonDays(map.get(NOTIFICATION_SETTING_KEYS.dueSoonDays) ?? null);
}

async function putSetting(exec: DocflowExecutor, key: string, value: string): Promise<void> {
  await executor(exec)
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function listNotificationTemplates(exec?: DocflowExecutor): Promise<NotificationTemplate[]> {
  const rows = await executor(exec).select().from(notificationTemplates);
  return rows
    .map((r) => ({
      key: r.key,
      title: r.title,
      body: r.body,
      isActive: r.isActive,
      updatedAt: toIso(r.updatedAt) ?? new Date().toISOString()
    }))
    // Порядок как у NOTIFICATION_KINDS: администратор видит виды в одном и том же порядке.
    .sort((a, b) => NOTIFICATION_KINDS.indexOf(a.key as NotificationKind) - NOTIFICATION_KINDS.indexOf(b.key as NotificationKind));
}

export async function getNotificationSettings(exec?: DocflowExecutor): Promise<NotificationSettingsView> {
  const map = await readSettingsMap(exec);
  return {
    enabled: parseSettingBoolean(map.get(NOTIFICATION_SETTING_KEYS.enabled) ?? null, true),
    dueSoonDays: parseDueSoonDays(map.get(NOTIFICATION_SETTING_KEYS.dueSoonDays) ?? null),
    workdayDeadlines: parseSettingBoolean(map.get(NOTIFICATION_SETTING_KEYS.workdayDeadlines) ?? null, true),
    holidays: parseHolidays(map.get(DEADLINES_HOLIDAYS_KEY) ?? null),
    variables: NOTIFICATION_VARIABLES.map((v) => ({ ...v })),
    templates: await listNotificationTemplates(exec)
  };
}

export interface NotificationSettingsInput {
  enabled?: boolean;
  dueSoonDays?: number;
  workdayDeadlines?: boolean;
  /** Праздники: не больше 100 дат в формате ГГГГ-ММ-ДД. */
  holidays?: string[];
  templates?: Array<{ key: string; title: string; body: string; isActive: boolean }>;
}

/**
 * Сохранение настроек уведомлений и шаблонов.
 *
 * ⚠️ Настройки, шаблоны и след аудита — ОДНА транзакция (AGENTS.md, п. 4): иначе при сбое
 * след говорил бы о настройке, которой нет, либо настройка менялась бы без следа.
 */
export async function saveNotificationSettings(
  input: NotificationSettingsInput,
  actor: Actor
): Promise<NotificationSettingsView> {
  if (
    input.dueSoonDays !== undefined &&
    (!Number.isInteger(input.dueSoonDays) ||
      input.dueSoonDays < 0 ||
      input.dueSoonDays > MAX_DUE_SOON_DAYS)
  ) {
    throw new AppError(
      "«За сколько дней предупреждать» — целое число от 0 до " + MAX_DUE_SOON_DAYS,
      400,
      "bad_due_soon_days"
    );
  }
  const holidays = input.holidays === undefined ? undefined : validateHolidays(input.holidays);

  const templates = (input.templates ?? []).map((t) => {
    if (!NOTIFICATION_KINDS.includes(t.key as NotificationKind)) {
      throw new AppError("Неизвестный вид уведомления: " + t.key, 400, "bad_template_key");
    }
    const title = String(t.title ?? "").trim();
    if (!title) throw new AppError("У шаблона «" + t.key + "» пустой заголовок", 400, "bad_template_title");
    return {
      key: t.key,
      title: title.slice(0, 200),
      body: String(t.body ?? "").slice(0, 2000),
      isActive: t.isActive !== false
    };
  });

  const before = await getNotificationSettings();

  await getDocflowDb().transaction(async (tx) => {
    if (input.enabled !== undefined) {
      await putSetting(tx, NOTIFICATION_SETTING_KEYS.enabled, input.enabled ? "true" : "false");
    }
    if (input.dueSoonDays !== undefined) {
      await putSetting(tx, NOTIFICATION_SETTING_KEYS.dueSoonDays, String(input.dueSoonDays));
    }
    if (input.workdayDeadlines !== undefined) {
      await putSetting(tx, NOTIFICATION_SETTING_KEYS.workdayDeadlines, input.workdayDeadlines ? "true" : "false");
    }
    if (holidays !== undefined) {
      await putSetting(tx, DEADLINES_HOLIDAYS_KEY, JSON.stringify(holidays));
    }
    for (const t of templates) {
      await tx
        .insert(notificationTemplates)
        .values({ key: t.key, title: t.title, body: t.body, isActive: t.isActive, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: notificationTemplates.key,
          set: { title: t.title, body: t.body, isActive: t.isActive, updatedAt: new Date() }
        });
    }
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: "notifications.settings",
      entityType: "settings",
      entityId: "notifications",
      oldValue: stringify(before),
      newValue: stringify(input)
    });
  });

  return getNotificationSettings();
}

// ---------------- Создание уведомлений ----------------

/**
 * Подстановка переменных в шаблон.
 *
 * Плоский текст без HTML (приложение А2): шаблон правит администратор, и вставлять его
 * в DOM как разметку нельзя. Незнакомую переменную НЕ вырезаем: опечатка в шаблоне
 * должна быть видна, а не превращаться в пустое место.
 */
export function renderNotificationTemplate(
  text: string,
  vars: Record<string, string | number | null | undefined> = {}
): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  entityId: string;
  entityType?: "resolution" | "document";
  /** Ключ идемпотентности: одинаковый ключ — одна строка на пользователя. */
  dedupeKey: string;
  vars?: Record<string, string | number | null | undefined>;
}

/**
 * Создаёт уведомление В ПЕРЕДАННОЙ ТРАНЗАКЦИИ — рядом с изменением, к которому оно относится.
 *
 * Ошибку НЕ глотаем: если уведомление не записалось, транзакция откатится вместе с самим
 * изменением. Иначе поручение ушло бы, а исполнитель о нём не узнал.
 *
 * @returns создана ли строка (false — уведомления выключены, вид выключен администратором
 *   или такой ключ уже есть).
 */
export async function notifyInTx(exec: DocflowExecutor, input: NotificationInput): Promise<boolean> {
  const db = executor(exec);
  if (!(await notificationsEnabled(db))) return false;

  const template = (
    await db.select().from(notificationTemplates).where(eq(notificationTemplates.key, input.kind)).limit(1)
  )[0];
  // Вид выключен администратором — его право: молчим осознанно, а не «теряем» уведомление.
  if (template && !template.isActive) return false;

  const vars = input.vars ?? {};
  const title = renderNotificationTemplate(template ? template.title : FALLBACK_TITLES[input.kind], vars).slice(0, 300);
  const body = renderNotificationTemplate(template ? template.body : "", vars).slice(0, 2000);

  const inserted = await db
    .insert(notifications)
    .values({
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      entityType: input.entityType ?? "resolution",
      entityId: input.entityId,
      title,
      body,
      severity: notificationSeverity(input.kind),
      dedupeKey: input.dedupeKey
    })
    // Цель конфликта указана явно: без цели гасится любой уникальный индекс, включая
    // частичный, и «конфликт» не отличить от настоящей вставки.
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
    .returning({ id: notifications.id });

  return inserted.length > 0;
}

// ---------------- Чтение, счётчик, прочтение ----------------

function mapNotification(row: typeof notifications.$inferSelect, deadline: string | null): AppNotification {
  return {
    id: row.id,
    kind: row.kind,
    entityType: row.entityType as AppNotification["entityType"],
    entityId: row.entityId,
    title: row.title,
    body: row.body,
    severity: row.severity as NotificationSeverity,
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    readAt: toIso(row.readAt),
    deadline,
    daysLeft: daysLeft(deadline),
    link: notificationLink(row.kind)
  };
}

export interface ListNotificationsOptions {
  limit?: number;
  unreadOnly?: boolean;
}

/** Свои уведомления. Чужие недоступны по построению: фильтр по user_id обязателен. */
export async function listNotifications(
  userId: string,
  opts: ListNotificationsOptions = {}
): Promise<NotificationPage> {
  const db = getDocflowDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  const totals = await db.select({ n: countExpr }).from(notifications).where(where);
  const unread = await countUnreadNotifications(userId);

  // Срок берём из резолюции: в уведомлении он не хранится, иначе после продления
  // срока в напоминании осталась бы старая дата.
  const resolutionIds = [
    ...new Set(rows.filter((r) => r.entityType === "resolution").map((r) => r.entityId))
  ];
  const deadlines = resolutionIds.length
    ? await db
        .select({ id: resolutions.id, deadline: resolutions.deadline })
        .from(resolutions)
        .where(inArray(resolutions.id, resolutionIds))
    : [];
  const deadlineById = new Map(deadlines.map((d) => [d.id, d.deadline]));

  return {
    items: rows.map((r) => mapNotification(r, deadlineById.get(r.entityId) ?? null)),
    unread,
    total: Number(totals[0]?.n ?? 0),
    enabled: await notificationsEnabled()
  };
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const rows = await getDocflowDb()
    .select({ n: countExpr })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Прочитать своё уведомление.
 *
 * @returns null — если строки нет ИЛИ она чужая (маршрут отвечает 404: 403 выдал бы
 *   само существование записи). Повторное прочтение безопасно.
 */
export async function markNotificationRead(
  id: string,
  userId: string
): Promise<{ ok: true; unread: number } | null> {
  const db = getDocflowDb();
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  if (updated.length === 0) {
    // Строка либо уже прочитана (тогда это не ошибка), либо чужая/несуществующая.
    const mine = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .limit(1);
    if (mine.length === 0) return null;
  }
  return { ok: true, unread: await countUnreadNotifications(userId) };
}

/** Отметить прочитанными ВСЕ свои. Возвращает число фактически обновлённых строк. */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const updated = await getDocflowDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return updated.length;
}

// ---------------- Материализация сроков (§3) ----------------

interface DeadlineRow {
  id: string;
  text: string;
  deadline: string | null;
  regNumber: string | null;
  summary: string | null;
}

async function insertDeadlineNotification(
  exec: DocflowExecutor,
  opts: {
    userId: string;
    kind: NotificationKind;
    row: DeadlineRow;
    daysLeft: number;
  }
): Promise<boolean> {
  const deadline = opts.row.deadline as string;
  return notifyInTx(exec, {
    userId: opts.userId,
    kind: opts.kind,
    entityId: opts.row.id,
    // Один раз на срок. Продление срока даёт новый ключ — и новое напоминание: это правильно.
    dedupeKey: opts.kind + ":" + opts.row.id + ":" + deadline,
    vars: {
      regNumber: opts.row.regNumber ?? "",
      summary: opts.row.summary ?? "",
      deadline,
      daysLeft: opts.daysLeft,
      text: opts.row.text
    }
  });
}

/**
 * Досчитывает недостающие уведомления о сроках для ОДНОГО пользователя.
 *
 * Детерминированно и идемпотентно: без cron и без курса на «сколько прошло времени» —
 * результат зависит только от текущей даты, сроков и настроек.
 *
 * @returns сколько строк реально создано.
 */
export async function materializeDeadlineNotifications(userId: string): Promise<number> {
  if (!userId) return 0;
  return getDocflowDb().transaction(async (tx) => {
    if (!(await notificationsEnabled(tx))) return 0;
    const dueSoonDays = await getDueSoonDays(tx);
    let created = 0;

    // 1) Сроки СВОИХ задач: только выданные (sent) и без отчёта этого исполнителя.
    const mine = await tx
      .select({
        id: resolutions.id,
        text: resolutions.text,
        deadline: resolutions.deadline,
        regNumber: documents.regNumber,
        summary: documents.summary
      })
      .from(resolutionAssignees)
      .innerJoin(resolutions, eq(resolutions.id, resolutionAssignees.resolutionId))
      .leftJoin(documents, eq(documents.id, resolutions.documentId))
      .where(
        and(
          eq(resolutionAssignees.userId, userId),
          eq(resolutions.status, "sent"),
          isNull(resolutionAssignees.reportAt),
          isNotNull(resolutions.deadline)
        )
      );

    for (const row of mine) {
      const left = daysLeft(row.deadline);
      if (left === null) continue;
      // Просроченная задача перестаёт быть due_soon/due_today: предупреждать о наступающем
      // сроке, который уже прошёл, — врать.
      const kind: NotificationKind | null =
        left < 0
          ? "resolution.overdue"
          : left === 0
            ? "resolution.due_today"
            : left <= dueSoonDays
              ? "resolution.due_soon"
              : null;
      if (!kind) continue;
      if (await insertDeadlineNotification(tx, { userId, kind, row, daysLeft: left })) created++;
    }

    // 2) Эскалация: аппарат ведёт сроки и узнаёт о просрочке от исполнителя.
    const escalations = await tx
      .select({
        id: resolutions.id,
        text: resolutions.text,
        deadline: resolutions.deadline,
        regNumber: documents.regNumber,
        summary: documents.summary
      })
      .from(resolutions)
      .leftJoin(documents, eq(documents.id, resolutions.documentId))
      .where(
        and(
          eq(resolutions.preparedBy, userId),
          eq(resolutions.status, "sent"),
          isNotNull(resolutions.deadline),
          sql`EXISTS (SELECT 1 FROM resolution_assignees a WHERE a.resolution_id = ${resolutions.id} AND a.report_at IS NULL)`
        )
      );

    for (const row of escalations) {
      const left = daysLeft(row.deadline);
      if (left === null || left >= 0) continue;
      if (
        await insertDeadlineNotification(tx, {
          userId,
          kind: "resolution.overdue_escalation",
          row,
          daysLeft: left
        })
      ) {
        created++;
      }
    }

    await pruneNotifications(tx, userId);
    return created;
  });
}

/**
 * Хранение: держим последние 500 уведомлений пользователя.
 *
 * Удаляем ТОЛЬКО прочитанные: непрочитанное напоминание — ещё не выполненная работа,
 * и «убрать, чтобы не росло» здесь означало бы тихую потерю.
 */
async function pruneNotifications(exec: DocflowExecutor, userId: string): Promise<number> {
  const db = executor(exec);
  const keep = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(NOTIFICATION_RETENTION);
  if (keep.length < NOTIFICATION_RETENTION) return 0;

  const removed = await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNotNull(notifications.readAt),
        notInArray(
          notifications.id,
          keep.map((k) => k.id)
        )
      )
    )
    .returning({ id: notifications.id });
  return removed.length;
}

/**
 * Материализация «на чтении»: ошибка не должна ронять список уведомлений (§3).
 * Список отдаём как есть, причину пишем в лог.
 */
export async function materializeDeadlineNotificationsSafe(userId: string): Promise<void> {
  try {
    await materializeDeadlineNotifications(userId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId },
      "Не удалось материализовать уведомления о сроках — список отдаётся как есть"
    );
  }
}
