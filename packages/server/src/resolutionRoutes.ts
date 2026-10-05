import type express from "express";
import { findReplyContext, suggestFields } from "./replySuggestions.js";
import {
  draftResolution,
  getAiConfig,
  getEmailView,
  getSettingValue,
  listAccounts,
  listAttachments,
  sendEmail
} from "@mailsense/core";
import {
  AppError,
  approveResolution,
  cancelResolution,
  closeResolution,
  confirmEmailApproval,
  confirmReport,
  createResolution,
  dispatchResolution,
  forwardToManager,
  getDocument,
  getUser,
  getUserByEmail,
  getResolution,
  getUserRoles,
  getResolutionDetail,
  listBoard,
  listDocumentResolutions,
  listMyTasks,
  listResolutions,
  listUsersWithRoles,
  permissionsOfRoles,
  markEmailApproval,
  markTaskReceived,
  rejectResolution,
  reportExecution,
  requestApproval,
  updateResolution,
  type Actor,
  type AssigneeKind,
  type Permission,
  type ResolutionPriority,
  type ResolutionStatus
} from "@mailsense/docflow";

/**
 * REST API резолюций (СЭД, этап 3).
 *
 * Права разведены по шагам процесса: аппарат готовит и отправляет, подписант утверждает.
 * Поэтому у маршрутов разные права, а не одно «резолюции».
 */
export interface ResolutionDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/** Исполнители приходят из формы: список с признаком ответственного. */
function assigneesFrom(v: unknown): Array<{ userId: string; kind: AssigneeKind }> {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = x as Record<string, unknown>;
      return {
        userId: String(o.userId ?? ""),
        kind: (o.kind === "responsible" ? "responsible" : "coexecutor") as AssigneeKind
      };
    })
    .filter((a) => a.userId);
}

export function mountResolutionRoutes(app: express.Express, deps: ResolutionDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const prepare = [requireDocflowDb, requirePermission("resolution.create")];
  const approve = [requireDocflowDb, requirePermission("resolution.approve")];
  const dispatch = [requireDocflowDb, requirePermission("resolution.dispatch")];
  const view = [requireDocflowDb, requirePermission("journal.view")];
  const tasks = [requireDocflowDb, requirePermission("task.view")];
  // Отчёт — отдельное право: задачу видеть мало, отчитываться должен тот, кому поручено.
  const report = [requireDocflowDb, requirePermission("task.report")];

  // -------- Черновик по письму: ИИ предлагает текст --------
  app.post(
    "/api/docflow/resolutions/draft",
    ...prepare,
    asyncHandler(async (req, res) => {
      const documentId = String((req.body ?? {}).documentId ?? "");
      const doc = await getDocument(documentId);
      if (!doc) throw new AppError("Документ не найден", 404, "not_found");
      if (!doc.emailId) {
        return res.json({ text: "", attachments: 0, reason: "no_email" });
      }
      const mail = getEmailView(doc.emailId);
      if (!mail) return res.json({ text: "", attachments: 0, reason: "email_removed" });

      const attachmentTexts = listAttachments(doc.emailId)
        .map((a) => a.extractedText ?? "")
        .filter((t) => t.trim().length > 0)
        .slice(0, 5);

      const text = await draftResolution(getAiConfig(), {
        subject: mail.subject ?? "",
        from: mail.from ? mail.from.name || mail.from.address : "",
        summary: mail.analysis?.summary ?? "",
        bodyText: mail.bodyText ?? "",
        attachmentTexts
      });
      res.json({ text, attachments: attachmentTexts.length });
    })
  );

  /**
   * Аппарат направляет письмо руководителю. Резолюции ещё нет — решает руководитель (Р8).
   * Вынесено до `/:id`, иначе Express примет «forward» за идентификатор.
   */
  app.post(
    "/api/docflow/resolutions/forward",
    // Пересылает ТОЛЬКО аппарат: право `resolution.dispatch` есть у него, но не у руководителя
    // и не у подписанта. Иначе руководитель мог бы направить письмо сам себе.
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const documentId = String(b.documentId ?? "");
      if (!documentId) throw new AppError("Не указан документ", 400, "no_document");

      const toUserId = b.toUserId ? String(b.toUserId) : "";
      if (!toUserId) throw new AppError("Не указано, кому направить письмо", 400, "no_recipient");
      const recipient = await getUser(toUserId);
      if (!recipient) throw new AppError("Получатель не найден", 404, "not_found");
      if (!recipient.email) throw new AppError("У получателя не заполнен адрес в каталоге", 400, "no_email");

      const doc = await getDocument(documentId);
      if (!doc) throw new AppError("Документ не найден", 404, "not_found");

      // Отправляем с ящика аппарата. Явно указанный accountId важнее: у предприятия
      // может быть несколько служебных ящиков, и не всегда нужен первый.
      // Ящик отправки: явно указанный → служебный из настроек → первый подходящий.
      // Служебный задаёт администратор: на предприятии ящиков несколько, и «первый попавшийся»
      // означал бы, что письмо руководителю уходит не от того адреса.
      const accounts = listAccounts();
      const configured = getSettingValue("docflow.serviceAccountId");
      const account =
        (b.accountId ? accounts.find((a) => a.id === String(b.accountId)) : undefined) ??
        (configured ? accounts.find((a) => a.id === configured) : undefined) ??
        accounts.find((a) => a.protocol === "imap") ??
        accounts[0];
      if (!account) throw new AppError("Не настроен почтовый ящик для отправки", 400, "no_account");

      // Письмо-источник: из него берём тему и цепочку, чтобы ответ руководителя
      // нашёлся в том же треде, а не повис отдельно.
      const source = doc.emailId ? getEmailView(doc.emailId) : null;
      const subject = source?.subject
        ? (source.subject.startsWith("Re:") ? source.subject : "Re: " + source.subject)
        : "Письмо " + (doc.regNumber || "без номера") + " — прошу наложить резолюцию";

      const bodyText = [
        (recipient.fullName || "Коллега") + ", добрый день!",
        "",
        "Направляю поступившее письмо для наложения резолюции.",
        doc.regNumber ? "Регистрационный номер: " + doc.regNumber + "." : "",
        doc.summary ? "Краткое содержание: " + doc.summary : "",
        source?.from ? "Отправитель: " + (source.from.name || source.from.address) : "",
        "",
        "Прошу указать поручение и исполнителя.",
        "",
        "—",
        "Аппарат генерального директора"
      ].filter((line) => line !== "").join("\n");

      const sent = await sendEmail({
        accountId: account.id,
        to: [{ address: recipient.email, name: recipient.fullName }],
        subject,
        bodyText,
        inReplyToEmailId: source?.id ?? null,
        inReplyToMessageId: source?.messageId ?? null,
        references: source?.messageId ? [source.messageId] : []
      });

      const created = await forwardToManager(documentId, actorOf(req), {
        emailId: sent.emailId,
        comment: b.comment ? String(b.comment) : "Письмо направлено: " + recipient.fullName
      });
      res.status(201).json({ ...created, sentTo: recipient.email, sentEmailId: sent.emailId });
    })
  );

  /**
   * Подсказка исполнителей. Сейчас НЕ реализована — граф знаний появится позже (Р14).
   *
   * Контракт зафиксирован заранее, чтобы интерфейс не пришлось переделывать: когда граф
   * появится, он начнёт заполнять `items`, а форма ответа не изменится. `collected` — сколько
   * резолюций уже накоплено: подсказка станет осмысленной не на пустой базе, и это видно.
   */
  app.get(
    "/api/docflow/resolutions/suggest-assignees",
    ...view,
    asyncHandler(async (req, res) => {
      const page = await listResolutions({ limit: 1 });
      res.json({
        ready: false,
        collected: page.total,
        needed: 300,
        items: [] as unknown[],
        reason: "graph_rag_not_implemented",
        documentId: str(req.query.documentId) ?? null
      });
    })
  );

  /**
   * Кандидаты в исполнители: активные пользователи с ФИО и адресом.
   *
   * ⚠️ Отдельный маршрут, а не `/api/users`: тот доступен только администратору, и экраны
   * аппарата и руководителя падали с «Недостаточно прав», оставаясь пустыми. Здесь же ровно
   * те данные, которые и так видны в журнале (кому поручено), — ничего лишнего не раскрываем.
   */
  app.get(
    "/api/docflow/resolutions/executor-candidates",
    ...view,
    asyncHandler(async (_req, res) => {
      const list = await listUsersWithRoles({ includeInactive: false });
      res.json(
        list
          .filter((u) => u.isActive && !u.blocked && u.email)
          .map((u) => ({ id: u.id, fullName: u.fullName, email: u.email, department: u.department ?? "" }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"))
      );
    })
  );

  /**
   * Подсказка по письму: не отвечает ли оно в переписке по какому-нибудь поручению.
   *
   * ⚠️ Это ФАКТ из заголовков (`In-Reply-To`/`References`), а не определение. Что за письмо —
   * резолюция руководителя или отчёт исполнителя — решает аппарат и отмечает сам.
   */
  app.get(
    "/api/docflow/emails/:emailId/reply-context",
    ...dispatch,
    asyncHandler(async (req, res) => {
      res.json(await findReplyContext(req.params.emailId));
    })
  );

  /**
   * Черновик полей по тексту письма. Модель вызывается ТОЛЬКО здесь — по нажатию кнопки,
   * а не при сканировании ящика: письма она не разбирает.
   */
  app.post(
    "/api/docflow/emails/:emailId/suggest-fields",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const kind = (req.body ?? {}).kind === "report" ? "report" : "approval";
      res.json(await suggestFields(req.params.emailId, kind));
    })
  );

  /**
   * Аппарат отметил письмо как резолюцию руководителя.
   *
   * Отметка человека и есть подтверждение: разбор свободного текста сам по себе основанием
   * быть не может, но здесь человек прочитал письмо и решил. Подписантом записывается
   * отправитель — с проверкой, что у него есть право подписи.
   */
  app.post(
    "/api/docflow/resolutions/:id/mark-approval",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const emailId = String(b.emailId ?? "");
      const mail = emailId ? getEmailView(emailId) : null;
      const from = mail?.from?.address ?? "";
      const signer = from ? await getUserByEmail(from) : null;
      if (!signer) throw new AppError("Не удалось определить отправителя письма", 400, "no_sender");
      const perms = permissionsOfRoles(await getUserRoles(signer.id));
      if (!perms.includes("resolution.approve")) {
        throw new AppError("Отправитель письма не имеет права подписи", 403, "no_sign_right");
      }
      // Если поручение уже помечено как «ответ письмом» (повторная разметка или старые данные),
      // первый шаг пропускаем: он допустим только из состояния «на утверждении».
      const current = await getResolution(req.params.id);
      if (current?.status === "pending_approval") {
        await markEmailApproval(
          req.params.id,
          { emailId, replyText: mail?.bodyText ?? "" },
          { id: signer.id, name: signer.fullName }
        );
      }
      res.json(
        await confirmEmailApproval(req.params.id, actorOf(req), {
          approvedBy: signer.id,
          text: b.text !== undefined ? String(b.text) : undefined,
          assignees: Array.isArray(b.assignees) ? b.assignees : undefined,
          deadline: b.deadline !== undefined ? b.deadline : undefined,
          priority: b.priority !== undefined ? b.priority : undefined
        })
      );
    })
  );

  /**
   * Очередь аппарата: ответы руководителя, ждущие подтверждения (Р9).
   *
   * ⚠️ Отдельно от `/for-approval`: та очередь — для подписанта и требует `resolution.approve`,
   * а подтверждает разбор аппарат. Без этого маршрута ответ руководителя распознавался, но
   * **никто его не видел** — резолюция молча висела в «ждёт подтверждения».
   */
  app.get(
    "/api/docflow/resolutions/for-confirmation",
    ...dispatch,
    asyncHandler(async (_req, res) => {
      const page = await listResolutions({ status: "email_approval", limit: 100 });
      res.json(page);
    })
  );

  // -------- Служебные маршруты (до /:id) --------
  app.get(
    "/api/docflow/resolutions/my-tasks",
    ...tasks,
    asyncHandler(async (req, res) => {
      if (!req.user) throw new AppError("Требуется вход", 401, "unauthorized");
      res.json(await listMyTasks(req.user.id));
    })
  );

  app.get(
    "/api/docflow/resolutions/for-approval",
    ...approve,
    asyncHandler(async (_req, res) => {
      const pending = await listResolutions({ status: "pending_approval", limit: 100 });
      const email = await listResolutions({ status: "email_approval", limit: 100 });
      res.json({ items: [...email.items, ...pending.items], total: pending.total + email.total });
    })
  );

  app.get(
    "/api/docflow/resolutions/board",
    ...view,
    asyncHandler(async (_req, res) => {
      res.json(await listBoard());
    })
  );

  app.get(
    "/api/docflow/resolutions/by-document/:documentId",
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await listDocumentResolutions(req.params.documentId));
    })
  );

  app.get(
    "/api/docflow/resolutions",
    ...view,
    asyncHandler(async (req, res) => {
      res.json(
        await listResolutions({
          status: str(req.query.status) as ResolutionStatus | undefined,
          documentId: str(req.query.documentId),
          assigneeId: str(req.query.assigneeId),
          limit: Number(req.query.limit) || 50,
          offset: Number(req.query.offset) || 0
        })
      );
    })
  );

  app.post(
    "/api/docflow/resolutions",
    ...prepare,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const created = await createResolution(
        {
          documentId: String(b.documentId ?? ""),
          text: String(b.text ?? ""),
          sourceText: b.sourceText ? String(b.sourceText) : "",
          sourceKind: b.sourceKind === "ai" ? "ai" : "manual",
          priority: (b.priority as ResolutionPriority) ?? "normal",
          deadline: b.deadline ? String(b.deadline) : null,
          assignees: assigneesFrom(b.assignees)
        },
        actorOf(req)
      );
      res.status(201).json(created);
    })
  );

  // -------- Карточка и шаги процесса --------
  app.get(
    "/api/docflow/resolutions/:id",
    ...view,
    asyncHandler(async (req, res) => {
      const detail = await getResolutionDetail(req.params.id);
      if (!detail) throw new AppError("Резолюция не найдена", 404, "not_found");
      res.json(detail);
    })
  );

  app.patch(
    "/api/docflow/resolutions/:id",
    ...prepare,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        await updateResolution(
          req.params.id,
          {
            text: b.text !== undefined ? String(b.text) : undefined,
            priority: b.priority as ResolutionPriority | undefined,
            deadline: b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : undefined,
            assignees: b.assignees !== undefined ? assigneesFrom(b.assignees) : undefined
          },
          actorOf(req)
        )
      );
    })
  );

  app.post(
    "/api/docflow/resolutions/:id/request-approval",
    ...prepare,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        await requestApproval(req.params.id, actorOf(req), {
          requestEmailId: b.requestEmailId ? String(b.requestEmailId) : null
        })
      );
    })
  );

  app.post(
    "/api/docflow/resolutions/:id/approve",
    ...approve,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      // Руководитель вправе написать текст и назначить исполнителя прямо при утверждении (Р8).
      res.json(
        await approveResolution(req.params.id, actorOf(req), {
          comment: str(b.comment),
          text: b.text !== undefined ? String(b.text) : undefined,
          assignees: b.assignees !== undefined ? assigneesFrom(b.assignees) : undefined,
          priority: b.priority as ResolutionPriority | undefined,
          deadline: b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : undefined
        })
      );
    })
  );

  /** Зафиксировать, что подписант ответил письмом: способ В, шаг 1. */
  app.post(
    "/api/docflow/resolutions/:id/email-approval",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const emailId = String(b.emailId ?? "");
      if (!emailId) throw new AppError("Не указано письмо с ответом", 400, "bad_email");
      res.json(
        await markEmailApproval(
          req.params.id,
          { emailId, replyText: String(b.replyText ?? "") },
          actorOf(req)
        )
      );
    })
  );

  /** Способ В, шаг 2: аппарат подтвердил разбор и утверждение (Р9). */
  app.post(
    "/api/docflow/resolutions/:id/confirm",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        await confirmEmailApproval(req.params.id, actorOf(req), {
          approvedBy: b.approvedBy ? String(b.approvedBy) : null,
          comment: str(b.comment),
          // Фамилию и срок из письма машина разобрать не может — их вписывает аппарат.
          text: b.text !== undefined ? String(b.text) : undefined,
          assignees: b.assignees !== undefined ? assigneesFrom(b.assignees) : undefined,
          priority: b.priority as ResolutionPriority | undefined,
          deadline: b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : undefined
        })
      );
    })
  );

  app.post(
    "/api/docflow/resolutions/:id/reject",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const comment = String((req.body ?? {}).comment ?? "");
      if (!comment.trim()) throw new AppError("Укажите причину возврата", 400, "no_comment");
      res.json(await rejectResolution(req.params.id, actorOf(req), comment));
    })
  );

  /** Отправка исполнителям: только аппарат и только после утверждения. */
  app.post(
    "/api/docflow/resolutions/:id/dispatch",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const detail = await getResolutionDetail(req.params.id);
      if (!detail) throw new AppError("Резолюция не найдена", 404, "not_found");
      const withEmail = detail.assignees.filter((a) => !!a.email);
      if (!withEmail.length) throw new AppError("У исполнителей не заполнены адреса", 400, "no_emails");

      const accounts = listAccounts();
      const configured = getSettingValue("docflow.serviceAccountId");
      const account =
        (configured ? accounts.find((a) => a.id === configured) : undefined) ??
        accounts.find((a) => a.protocol === "imap") ??
        accounts[0];
      if (!account) throw new AppError("Не настроен почтовый ящик для отправки", 400, "no_account");

      // Одно письмо на всех исполнителей — как в бумажном журнале, где в графе 8
      // перечислены все. Разные письма раздули бы переписку и разошлись бы по тредам.
      const doc = await getDocument(detail.documentId);
      const source = doc?.emailId ? getEmailView(doc.emailId) : null;
      const responsible = withEmail.find((a) => a.kind === "responsible") ?? withEmail[0];

      const bodyText = [
        "Поручение по документу " + (detail.documentNumber || "без номера") + ".",
        "",
        detail.text,
        "",
        detail.deadline ? "Срок: " + detail.deadline.split("-").reverse().join(".") : "Срок не указан.",
        "Ответственный: " + responsible.fullName,
        withEmail.length > 1
          ? "Соисполнители: " + withEmail.filter((a) => a.userId !== responsible.userId).map((a) => a.fullName).join(", ")
          : "",
        "",
        "—",
        "Аппарат генерального директора"
      ].filter((l) => l !== "").join("\n");

      const sent = await sendEmail({
        accountId: account.id,
        to: withEmail.map((a) => ({ address: a.email, name: a.fullName })),
        subject: "Поручение " + (detail.documentNumber || "") + ": " + detail.text.slice(0, 60),
        bodyText,
        // Ссылаемся на исходное письмо: переписка по делу остаётся одной цепочкой.
        inReplyToEmailId: source?.id ?? null,
        inReplyToMessageId: source?.messageId ?? null,
        references: source?.messageId ? [source.messageId] : []
      });

      res.json(
        await dispatchResolution(req.params.id, actorOf(req), {
          dispatchEmailId: sent.emailId,
          comment: str(b.comment)
        })
      );
    })
  );

  app.post(
    "/api/docflow/resolutions/:id/cancel",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const comment = String((req.body ?? {}).comment ?? "");
      if (!comment.trim()) throw new AppError("Укажите причину отмены", 400, "no_comment");
      res.json(await cancelResolution(req.params.id, actorOf(req), comment));
    })
  );

  /**
   * Задача в календарь исполнителя (Р11). Отдаём .ics — файл понимает любой календарь,
   * и напоминания делает он, а не мы: отдельные письма-напоминания не нужны.
   */
  app.get(
    "/api/docflow/resolutions/:id/ics",
    ...tasks,
    asyncHandler(async (req, res) => {
      const detail = await getResolutionDetail(req.params.id);
      if (!detail) throw new AppError("Резолюция не найдена", 404, "not_found");
      if (!detail.deadline) throw new AppError("У задачи не указан срок — в календарь нечего ставить", 400, "no_deadline");

      const day = detail.deadline.replace(/-/g, "");
      const responsible = detail.assignees.find((a) => a.kind === "responsible") ?? detail.assignees[0];
      const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MailSense//СЭД//RU",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        "UID:" + detail.id + "@mailsense",
        "DTSTAMP:" + stamp,
        // Срок — событие на весь день: конкретный час в поручениях не указывают.
        "DTSTART;VALUE=DATE:" + day,
        "SUMMARY:" + esc("Срок: " + (detail.documentNumber || "документ") + " — " + detail.text.slice(0, 80)),
        "DESCRIPTION:" + esc(detail.text + (responsible ? "\\n\nОтветственный: " + responsible.fullName : "")),
        "BEGIN:VALARM",
        "TRIGGER:-P3D",
        "ACTION:DISPLAY",
        "DESCRIPTION:" + esc("Через 3 дня срок по " + (detail.documentNumber || "документу")),
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="task-' + detail.id + '.ics"');
      res.send(ics);
    })
  );

  /** Отчёт исполнителя об исполнении (этап 4). */
  app.post(
    "/api/docflow/resolutions/:id/report",
    ...report,
    asyncHandler(async (req, res) => {
      if (!req.user) throw new AppError("Требуется вход", 401, "unauthorized");
      const b = req.body ?? {};
      // Отчитывается тот, кто вошёл: «отчёт за другого» не принимаем.
      res.json(
        await reportExecution(
          req.params.id,
          req.user.id,
          { text: String(b.text ?? ""), emailId: b.emailId ? String(b.emailId) : null },
          actorOf(req)
        )
      );
    })
  );

  /** Закрытие поручения аппаратом — когда исполнитель отчитался не в приложении. */
  app.post(
    "/api/docflow/resolutions/:id/close",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const comment = String((req.body ?? {}).comment ?? "");
      if (!comment.trim()) throw new AppError("Укажите, на каком основании закрываете", 400, "no_comment");
      res.json(await closeResolution(req.params.id, actorOf(req), comment));
    })
  );

  /**
   * Аппарат отметил письмо как отчёт об исполнении: принимает отчёт и запускает правило
   * закрытия (Р10). Отчитывается исполнитель, но принимает человек — он прочитал письмо.
   */
  app.post(
    "/api/docflow/resolutions/:id/report/confirm",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const userId = String(b.userId ?? "");
      if (!userId) throw new AppError("Не указан исполнитель", 400, "no_user");
      res.json(
        await confirmReport(
          req.params.id,
          userId,
          { text: b.text !== undefined ? String(b.text) : undefined },
          actorOf(req)
        )
      );
    })
  );

  /** «Расписка»: исполнитель получил документ (графа 8 журнала). */
  app.post(
    "/api/docflow/resolutions/:id/received",
    ...tasks,
    asyncHandler(async (req, res) => {
      if (!req.user) throw new AppError("Требуется вход", 401, "unauthorized");
      await markTaskReceived(req.params.id, req.user.id);
      res.json({ ok: true });
    })
  );
}