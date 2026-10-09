import type express from "express";
import {
  AppError,
  addCalendarDays,
  countUnreadNotifications,
  deleteSortRule,
  getNotificationSettings,
  getSortRule,
  listDeadlinePresets,
  listNotifications,
  listSortRules,
  markAllNotificationsRead,
  markNotificationRead,
  materializeDeadlineNotificationsSafe,
  notificationsEnabled,
  saveNotificationSettings,
  saveSortRule,
  setSortRuleValidator,
  type Actor,
  type MailSortRuleRecord,
  type NotificationSettingsInput,
  type Permission
} from "@mailsense/docflow";
import {
  addWorkingDays,
  isWorkingDay,
  matchSortRules,
  validateSortRule,
  type MailSortRule
} from "@mailsense/core";
import { mailSortInput, personText, unregisteredInbox } from "./journalRoutes.js";
import { intParam } from "./params.js";

/**
 * Центр уведомлений и правила автосортировки (§6 контракта + приложение А).
 *
 * Право проверяет СЕРВЕР (requirePermission), интерфейс лишь прячет кнопки.
 * `notifications.view` есть у всех пяти ролей, но не у учётки без ролей:
 * уведомления адресные, и «пустой список» у роли без прав отличался бы от «нет уведомлений».
 *
 * ⚠️ Писем-напоминаний здесь НЕТ и быть не должно (Р11, А8): уведомления живут только
 * внутри приложения. Ни один маршрут этого файла не ходит в sendService/SMTP — это
 * проверяется тестом (server/notifications.routes.test.ts).
 */
export interface NotificationDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  /** «Любое из прав»: справочник нужен и тому, кто поручает, и тому, кто подписывает. */
  requireAnyPermission: (...permissions: Permission[]) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

/** Маршруты уведомлений адресные: без пользователя они бессмысленны. */
function currentUserId(req: express.Request): string {
  if (!req.user) throw new AppError("Требуется вход", 401, "unauthorized");
  return req.user.id;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/** Поля правила из тела запроса. Отсутствующие не передаём: PATCH обязан быть частичным. */
function rulePatchFrom(body: Record<string, unknown>): Partial<MailSortRuleRecord> {
  const out: Partial<MailSortRuleRecord> = {};
  if (body.name !== undefined) out.name = String(body.name);
  if (body.isActive !== undefined) out.isActive = !!body.isActive;
  if (body.sortOrder !== undefined) out.sortOrder = Number(body.sortOrder);
  if (body.matchFrom !== undefined) out.matchFrom = String(body.matchFrom);
  if (body.matchTo !== undefined) out.matchTo = String(body.matchTo);
  if (body.matchSubject !== undefined) out.matchSubject = String(body.matchSubject);
  if (body.label !== undefined) out.label = String(body.label);
  if (body.note !== undefined) out.note = String(body.note);
  if (body.priority !== undefined) {
    out.priority = body.priority === null || body.priority === "" ? null : Number(body.priority);
  }
  return out;
}

/**
 * Проверка правила — ровно та же, что у клиента и предпросмотра: `validateSortRule` из core (§5).
 * Вторая проверка «на стороне сервера» разошлась бы с матчингом, и правило сохранялось бы
 * с ошибкой, которую видно только на письмах.
 */
function assertRuleValid(rule: Partial<MailSortRule>): void {
  const check = validateSortRule(rule);
  if (!check.ok) throw new AppError("Правило не сохранено: " + check.errors.join("; "), 400, "bad_rule");
}

/** Дата ГГГГ-ММ-ДД и она обязана существовать: 30 февраля 2026 года не бывает. */
function assertIsoDay(value: string, message: string): void {
  try {
    isWorkingDay(value, []);
  } catch {
    throw new AppError(message + ": " + value, 400, "bad_from");
  }
}

export function mountNotificationRoutes(app: express.Express, deps: NotificationDeps): void {
  const { requireDocflowDb, requirePermission, requireAnyPermission, asyncHandler } = deps;
  // Регистрируем проверку правил из ядра в хранилище docflow: тогда границы §5 действуют
  // для ЛЮБОГО вызывающего (маршрут, сид, будущий CRUD), а реализация проверки одна — core.
  setSortRuleValidator(validateSortRule);
  const view = [requireDocflowDb, requirePermission("notifications.view")];
  const manage = [requireDocflowDb, requirePermission("settings.manage")];
  // Типовые сроки нужны и подписанту: при утверждении он ВПРАВЕ поставить срок (этап 3),
  // а без справочника чипы сроков у него пустые. Исполнителю он по-прежнему не нужен.
  const deadlinePresets = [
    requireDocflowDb,
    requireAnyPermission("resolution.create", "resolution.approve")
  ];

  // -------- Служебные пути объявляются ДО /:id --------

  /**
   * Дешёвый вызов для бейджа (§6). Материализация сроков идёт здесь же: иначе бейдж
   * не показал бы просрочку, пока человек не откроет центр уведомлений.
   */
  app.get(
    "/api/docflow/notifications/count",
    ...view,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      await materializeDeadlineNotificationsSafe(userId);
      res.json({ unread: await countUnreadNotifications(userId), enabled: await notificationsEnabled() });
    })
  );

  /** Настройки и шаблоны: админская вкладка. Чтение — тоже под settings.manage (§6). */
  app.get(
    "/api/docflow/notifications/settings",
    ...manage,
    asyncHandler(async (_req, res) => {
      res.json(await getNotificationSettings());
    })
  );

  app.put(
    "/api/docflow/notifications/settings",
    ...manage,
    asyncHandler(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const input: NotificationSettingsInput = {};
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== "boolean") throw new AppError("«Уведомления включены» — да или нет", 400, "bad_enabled");
        input.enabled = b.enabled;
      }
      if (b.dueSoonDays !== undefined) {
        if (typeof b.dueSoonDays !== "number" || !Number.isInteger(b.dueSoonDays)) {
          throw new AppError("«За сколько дней предупреждать» — целое число от 0 до 30", 400, "bad_due_soon_days");
        }
        input.dueSoonDays = b.dueSoonDays;
      }
      if (b.workdayDeadlines !== undefined) {
        if (typeof b.workdayDeadlines !== "boolean") {
          throw new AppError("«Считать срок в рабочих днях» — да или нет", 400, "bad_workday_deadlines");
        }
        input.workdayDeadlines = b.workdayDeadlines;
      }
      if (b.holidays !== undefined) {
        if (!Array.isArray(b.holidays)) throw new AppError("Праздники должны быть списком дат", 400, "bad_holidays");
        input.holidays = b.holidays.map((v) => String(v ?? ""));
      }
      if (b.templates !== undefined) {
        if (!Array.isArray(b.templates)) throw new AppError("Шаблоны должны быть списком", 400, "bad_templates");
        input.templates = b.templates.map((raw) => {
          const t = (raw ?? {}) as Record<string, unknown>;
          return {
            key: String(t.key ?? ""),
            title: String(t.title ?? ""),
            body: String(t.body ?? ""),
            isActive: t.isActive !== false
          };
        });
      }
      await saveNotificationSettings(input, actorOf(req));
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/docflow/notifications/read-all",
    ...view,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const updated = await markAllNotificationsRead(userId);
      res.json({ updated, unread: 0 });
    })
  );

  /** Список уведомлений. Свои — по user_id из сессии, чужих здесь быть не может. */
  app.get(
    "/api/docflow/notifications",
    ...view,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      await materializeDeadlineNotificationsSafe(userId);
      const limit = intParam(req.query.limit, "limit", { fallback: 50, min: 1, max: 200 });
      res.json(await listNotifications(userId, { limit, unreadOnly: req.query.unread === "1" }));
    })
  );

  /**
   * Прочтение одного уведомления.
   *
   * ⚠️ Чужая запись — 404, а не 403: 403 выдал бы само её существование (IDOR).
   * Фильтр по user_id стоит в самом UPDATE, а не только в проверке перед ним.
   */
  app.post(
    "/api/docflow/notifications/:id/read",
    ...view,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const result = await markNotificationRead(req.params.id, userId);
      if (!result) throw new AppError("Уведомление не найдено", 404, "not_found");
      res.json(result);
    })
  );

  // -------- Правила автосортировки (§6) --------

  app.get(
    "/api/docflow/sorting/rules",
    ...manage,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listSortRules() });
    })
  );

  /**
   * Предпросмотр правила на письмах «Входящих на регистрацию». НИЧЕГО не записывает
   * и НЕ регистрирует документы: правило вообще не создаёт документов — это проверяет тест.
   */
  app.post(
    "/api/docflow/sorting/rules/preview",
    ...manage,
    asyncHandler(async (req, res) => {
      const candidate = rulePatchFrom((req.body ?? {}) as Record<string, unknown>);
      const rule: MailSortRule = {
        id: "preview",
        name: candidate.name ?? "",
        isActive: candidate.isActive ?? true,
        sortOrder: candidate.sortOrder ?? 0,
        matchFrom: candidate.matchFrom ?? "",
        matchTo: candidate.matchTo ?? "",
        matchSubject: candidate.matchSubject ?? "",
        label: candidate.label ?? "",
        priority: candidate.priority ?? null,
        note: candidate.note ?? ""
      };
      assertRuleValid(rule);

      const emails = await unregisteredInbox(str(req.query.folder) ?? "INBOX", currentUserId(req));
      const samples: Array<{
        emailId: string;
        subject: string;
        from: string;
        labels: string[];
        notes: string[];
        priority: number | null;
      }> = [];
      let matchedCount = 0;
      for (const email of emails) {
        const match = matchSortRules([rule], mailSortInput(email));
        if (!match.matched) continue;
        matchedCount++;
        if (samples.length < 20) {
          samples.push({
            emailId: email.id,
            subject: email.subject ?? "",
            from: personText(email.from),
            labels: match.labels,
            notes: match.notes,
            priority: match.priority
          });
        }
      }
      res.json({ matched: matchedCount, total: emails.length, samples });
    })
  );

  app.post(
    "/api/docflow/sorting/rules",
    ...manage,
    asyncHandler(async (req, res) => {
      const patch = rulePatchFrom((req.body ?? {}) as Record<string, unknown>);
      assertRuleValid(patch as Partial<MailSortRule>);
      res.status(201).json({ rule: await saveSortRule(patch, actorOf(req)) });
    })
  );

  app.patch(
    "/api/docflow/sorting/rules/:id",
    ...manage,
    asyncHandler(async (req, res) => {
      const existing = await getSortRule(req.params.id);
      if (!existing) throw new AppError("Правило не найдено", 404, "not_found");
      const patch = rulePatchFrom((req.body ?? {}) as Record<string, unknown>);
      // Проверяем ИТОГ правки, а не только присланные поля: иначе «убрать последний матчер»
      // прошло бы проверку, и правило начало бы ловить всю почту.
      assertRuleValid({ ...existing, ...patch } as Partial<MailSortRule>);
      res.json({ rule: await saveSortRule({ id: req.params.id, ...patch }, actorOf(req)) });
    })
  );

  app.delete(
    "/api/docflow/sorting/rules/:id",
    ...manage,
    asyncHandler(async (req, res) => {
      const removed = await deleteSortRule(req.params.id, actorOf(req));
      if (!removed) throw new AppError("Правило не найдено", 404, "not_found");
      res.json({ ok: true });
    })
  );

  /**
   * Типовые сроки с посчитанной датой (А9).
   *
   * Считает ядро (`addWorkingDays`), а не сервер: выходные и праздники — его предмет.
   * Праздники приходят уже провалидированными при чтении настроек (А10, D-1), поэтому
   * `RangeError` ядра здесь означал бы порчу данных, а не ошибку пользователя.
   */
  app.get(
    "/api/docflow/deadline-presets",
    ...deadlinePresets,
    asyncHandler(async (req, res) => {
      const from = str(req.query.from) ?? new Date().toISOString().slice(0, 10);
      assertIsoDay(from, "Дата отсчёта должна быть в виде ГГГГ-ММ-ДД");

      const settings = await getNotificationSettings();
      const presets = await listDeadlinePresets();
      const items = presets.map((preset) => ({
        id: preset.id,
        title: preset.title,
        days: preset.days,
        isWorkday: preset.isWorkday,
        dueDate:
          preset.isWorkday && settings.workdayDeadlines
            ? addWorkingDays(from, preset.days, settings.holidays)
            : addCalendarDays(from, preset.days)
      }));
      res.json({ workdayDeadlines: settings.workdayDeadlines, holidays: settings.holidays, items });
    })
  );
}
