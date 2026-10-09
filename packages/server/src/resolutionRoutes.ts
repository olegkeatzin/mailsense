import type express from "express";
import fs from "node:fs";
import { findReplyContext, suggestFields } from "./replySuggestions.js";
import { intParam } from "./params.js";
import { selectSendAccount, type SendAccountLike } from "./serviceAccount.js";
import {
  draftResolution,
  getAiConfig,
  getEmailView,
  listAccounts,
  listAttachments,
  logger,
  sendEmail
} from "@mailsense/core";
import {
  AppError,
  EDMS_WORK_ACCOUNT_SETTING,
  approveResolution,
  attachDispatchEmail,
  attachRequestEmail,
  cancelResolution,
  closeResolution,
  confirmEmailApproval,
  confirmReport,
  createResolution,
  dispatchResolution,
  forwardToManager,
  getDocument,
  getServiceAccountState,
  getUser,
  getUserByEmail,
  getResolution,
  getUserRoles,
  getResolutionDetail,
  getUserSetting,
  listBoard,
  listDocumentResolutions,
  listMyTasks,
  listResolutions,
  listUsersWithRoles,
  permissionsOfRoles,
  markEmailApproval,
  markTaskReceived,
  recomputeUserStats,
  rejectResolution,
  reportExecution,
  requestApproval,
  revertDispatch,
  updateResolution,
  writeAudit,
  type Actor,
  type AssigneeKind,
  type Permission,
  type ResolutionDetail,
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
  /** Право «любое из списка»: справочник исполнителей нужен и создающему, и подписанту. */
  requireAnyPermission: (...permissions: Permission[]) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

/**
 * Пересчёт агрегата «профиль исполнителя» после закрытия поручения (task-18).
 *
 * Fire-and-forget: агрегат — ПРОИЗВОДНЫЕ данные. Он не должен ни удлинять ответ аппарату,
 * ни ломать закрытие: ошибку пишем в лог, а полный пересчёт при старте сервера доберёт
 * потерянное, если процесс упал между закрытием и пересчётом.
 */
function scheduleStatsRecompute(result: { id?: string; status?: string } | null | undefined): void {
  if (!result || result.status !== "done" || !result.id) return;
  const resolutionId = result.id;
  void (async () => {
    try {
      const detail = await getResolutionDetail(resolutionId);
      if (!detail) return;
      const users = [
        ...new Set(
          [...(detail.assignees ?? []).map((a) => a.userId), detail.preparedBy, detail.approvedBy].filter(
            (v): v is string => !!v
          )
        )
      ];
      await recomputeUserStats({ userIds: users });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, resolutionId },
        "Не удалось пересчитать агрегат профиля исполнителя"
      );
    }
  })();
}

/**
 * Ящик отправки служебных писем (Р12, task-11).
 *
 * Один помощник на /forward и /dispatch: раньше в обоих местах была копипаста «первый imap»,
 * и на стенде им оказывался ящик директора без SMTP.
 *
 * ⚠️ Отказ бросается ДО перехода резолюции: иначе поручение осталось бы «отправлено»
 * без письма, а причина была бы видна только в логе почтового сервера.
 */
async function resolveSendAccount(workerId: string | null, explicitId: string | null): Promise<SendAccountLike> {
  // ⚠️ Р24: в СЭД разрешены РОВНО два ящика — служебный внутренний предприятия и ЛИЧНЫЙ
  // рабочий ЭТОГО работника (его выбор «почта для СЭД»). «Первый подходящий» запрещён.
  // Внешняя приёмная в список не входит: с неё уходит только ответ контрагенту (композер).
  const [state, personalId] = await Promise.all([
    getServiceAccountState(),
    workerId ? getUserSetting(workerId, EDMS_WORK_ACCOUNT_SETTING) : Promise.resolve(null)
  ]);
  const allowedIds = [personalId, state.accountId].filter((id): id is string => !!id);

  const selection = selectSendAccount(listAccounts(), {
    explicitId,
    personalId,
    configuredId: state.accountId,
    // Выбор снят явно (строка настроек есть, значение пустое) — «первый попавшийся» запрещён.
    cleared: state.explicit && state.accountId === null,
    allowedIds
  });

  if (selection.warning) {
    logger.warn({ source: selection.source, accountId: selection.account?.id ?? null }, selection.warning);
  }
  if (!selection.account || selection.problem) {
    // Ящик вне разрешённых — это запрет (403), а не «неправильные данные»: работник пытается
    // отправить официальное письмо не со своего ящика.
    const status = selection.problemCode === "account_not_allowed" ? 403 : 400;
    throw new AppError(
      selection.problem ?? "Не настроен почтовый ящик для отправки",
      status,
      selection.problemCode === "ok" ? "no_account" : selection.problemCode
    );
  }
  return selection.account;
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

/**
 * Проверяет, что у пользователя есть право подписи.
 *
 * ⚠️ Подписанта называют снаружи (аппарат прочитал письмо, администратор выбрал вручную),
 * поэтому право проверяет сервер: иначе в графе «Резолюция руководства» окажется любой,
 * чей идентификатор попал в тело запроса.
 */
/**
 * Участник поручения: исполнитель, автор, подписант, подтвердивший разбор или отправивший.
 *
 * ⚠️ Список — это ровно те, кому поручение адресовано или кто его вёл. «Коллега с правом
 * видеть журнал» участником не становится: чужие сроки, тексты и соисполнители ему ни к чему
 * (решение заказчика 2026-10-05).
 */
function isResolutionParticipant(detail: ResolutionDetail, userId: string): boolean {
  return (
    detail.assignees.some((a) => a.userId === userId) ||
    detail.preparedBy === userId ||
    detail.approvedBy === userId ||
    detail.confirmedBy === userId ||
    detail.dispatchedBy === userId
  );
}

/**
 * Пропускает к карточке поручения только участника или того, кто поручениями управляет.
 *
 * Проверка на сервере, а не в интерфейсе: право journal.view есть у всех ролей, включая
 * исполнителя, поэтому одной этой проверки на маршруте мало — карточка обходила решение
 * заказчика в два запроса (список документов → карточка поручения).
 */
function assertResolutionVisible(req: express.Request, detail: ResolutionDetail): void {
  const user = req.user;
  if (!user) throw new AppError("Требуется вход", 401, "unauthorized");
  if (user.permissions.includes("resolution.create")) return;
  // Подписанту нужно открыть то, что ждёт его подписи: очередь «На утверждении» отдаёт
  // ему эти поручения списком, и карточка не должна оказаться закрытой.
  const awaitingSignature =
    user.permissions.includes("resolution.approve") &&
    (detail.status === "pending_approval" || detail.status === "email_approval");
  if (awaitingSignature) return;
  if (isResolutionParticipant(detail, user.id)) return;
  throw new AppError("Поручение не ваше: карточка доступна участнику поручения", 403, "not_participant");
}
/**
 * Проверяет право подписи у названного человека.
 *
 * ⚠️ Отказ в подписи — событие безопасности, и он оставляет след (D-3, task-14): без записи
 * спор «кто пытался подписать и кого назвал подписантом» разрешить нечем. Пишем через
 * `writeAudit` ВНЕ транзакции: отказ ничего не меняет, откатывать нечего — тот же приём,
 * что у `journal.register_denied`. Сбой записи следа не подменяет отказ наружу.
 */
async function assertSignRight(
  userId: string,
  message = "У пользователя нет права подписи",
  ctx: { actor: Actor; resolutionId?: string; email?: string | null } = { actor: { id: null, name: "" } }
): Promise<void> {
  const user = await getUser(userId);
  const perms = user ? permissionsOfRoles(await getUserRoles(user.id)) : [];
  if (user && perms.includes("resolution.approve")) return;

  try {
    await writeAudit({
      userId: ctx.actor.id,
      userName: ctx.actor.name,
      action: "resolution.approve_denied",
      entityType: "resolution",
      entityId: ctx.resolutionId ?? "",
      newValue: JSON.stringify({
        reason: user ? "no_sign_right" : "no_signer",
        message,
        candidateId: userId,
        candidateEmail: ctx.email ?? user?.email ?? null
      })
    });
  } catch (err) {
    // Сбой следа не подменяет сам отказ: человек должен увидеть «недостаточно прав»,
    // а не 500. Причину пишем в лог (прецедент journal.register_denied).
    logger.warn({ err: (err as Error).message, resolutionId: ctx.resolutionId }, "Не удалось записать отказ в подписи");
  }

  if (!user) throw new AppError("Утверждающий не найден", 400, "no_signer");
  throw new AppError(message, 403, "no_sign_right");
}

export function mountResolutionRoutes(app: express.Express, deps: ResolutionDeps): void {
  const { requireDocflowDb, requireAnyPermission, requirePermission, asyncHandler } = deps;
  const prepare = [requireDocflowDb, requirePermission("resolution.create")];
  const approve = [requireDocflowDb, requirePermission("resolution.approve")];
  const dispatch = [requireDocflowDb, requirePermission("resolution.dispatch")];
  const view = [requireDocflowDb, requirePermission("journal.view")];
  const tasks = [requireDocflowDb, requirePermission("task.view")];
  // Справочник людей — управленческий вид: тот, кто поручает (resolution.create), и тот,
  // кто подписывает (resolution.approve, он назначает исполнителя при утверждении, Р8).
  // Исполнителю он не нужен: там ФИО и адреса всех сотрудников предприятия.
  const assignees = [requireDocflowDb, requireAnyPermission("resolution.create", "resolution.approve")];
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
      // Ящик отправки: явно указанный → служебный из настроек → первый готовый (Р12).
      const account = await resolveSendAccount(req.user?.id ?? null, b.accountId ? String(b.accountId) : null);

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

      // ⚠️ Порядок как в /dispatch: сначала захват (forwardToManager — он же запрещает
      // повторную пересылку), и только потом письмо. Раньше двойной клик отправлял
      // руководителю ДВА письма, а записывалось одно: человек видел ошибку и был уверен,
      // что не отправилось.
      const created = await forwardToManager(documentId, actorOf(req), {
        comment: b.comment ? String(b.comment) : "Письмо направлено: " + recipient.fullName
      });

      let sent: { emailId: string };
      try {
        sent = await sendEmail({
          accountId: account.id,
          to: [{ address: recipient.email, name: recipient.fullName }],
          subject,
          bodyText,
          inReplyToEmailId: source?.id ?? null,
          inReplyToMessageId: source?.messageId ?? null,
          references: source?.messageId ? [source.messageId] : []
        });
      } catch (err) {
        // Письмо не ушло — снимаем пересылку, иначе аппарат не сможет повторить:
        // поручение осталось бы «на утверждении», которого руководитель не видел.
        await cancelResolution(
          created.id,
          actorOf(req),
          "Письмо руководителю не отправлено: " + (err as Error).message
        ).catch((rollbackError: Error) => {
          logger.warn(
            { err: rollbackError.message, resolutionId: created.id },
            "Не удалось снять пересылку после сбоя отправки"
          );
        });
        throw err;
      }

      // Шаг 3: письмо ушло — записываем его идентификатор. Без этой записи requestEmailId
      // пуст, и ответ руководителя письмом не сопоставляется с поручением: кандидатов
      // listReplyCandidates ищет именно по нему, а шаг истории остаётся «manual».
      const withEmail = await attachRequestEmail(created.id, sent.emailId, actorOf(req));
      res.status(201).json({ ...withEmail, sentTo: recipient.email, sentEmailId: sent.emailId });
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
    ...assignees,
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
   * аппарата и руководителя падали с «Недостаточно прав», оставаясь пустыми. Доступ — тем,
   * кто поручает или подписывает: исполнителю ФИО и адреса всех сотрудников не нужны.
   */
  app.get(
    "/api/docflow/resolutions/executor-candidates",
    ...assignees,
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
   * Письмо-источник по задаче (T41, план Т5).
   *
   * После закрытия прав на почту (D-4/T39) у исполнителя нет `mail.view`, но он обязан видеть,
   * ЧТО именно исполняет. Поэтому тело письма отдаётся здесь — через документооборот и только
   * участнику ЭТОГО поручения: исполнителю, подписанту/утвердившему, а также аппарату, который
   * поручение готовил, отправлял или подтверждал. Чужая задача → 403, письмо без связи с
   * поручением → 404: посторонний не получает даже факта существования письма.
   */
  const taskView = [requireDocflowDb, requirePermission("task.view")];

  async function sourceEmailOf(req: express.Request): Promise<{ detail: ResolutionDetail; emailId: string }> {
    const user = req.user;
    if (!user) throw new AppError("Требуется вход в систему", 401, "unauthorized");

    const detail = await getResolutionDetail(req.params.resolutionId);
    if (!detail) throw new AppError("Поручение не найдено", 404, "not_found");

    const participant =
      detail.assignees.some((a) => a.userId === user.id) ||
      detail.approvedBy === user.id ||
      detail.preparedBy === user.id ||
      detail.dispatchedBy === user.id ||
      detail.confirmedBy === user.id;

    if (!participant) {
      // Отказ фиксируем вне транзакции, как другие отказы доступа (прецедент approve_denied).
      // ⚠️ Сбой следа не подменяет отказ: человек должен увидеть «не ваше поручение», а не 500.
      try {
        await writeAudit({
          userId: user.id,
          userName: user.fullName,
          action: "resolution.source_email_denied",
          entityType: "resolution",
          entityId: detail.id,
          newValue: JSON.stringify({ reason: "not_participant" })
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, resolutionId: detail.id }, "Не удалось записать отказ доступа к письму-источнику");
      }
      throw new AppError("Это поручение не ваше", 403, "forbidden");
    }

    const emailId = detail.documentEmailId ?? "";
    if (!emailId) throw new AppError("Письмо-источник не связано с поручением", 404, "not_found");
    return { detail, emailId };
  }

  app.get(
    "/api/docflow/tasks/:resolutionId/source-email",
    ...taskView,
    asyncHandler(async (req, res) => {
      const { detail, emailId } = await sourceEmailOf(req);
      const mail = getEmailView(emailId);
      if (!mail) throw new AppError("Письмо не найдено", 404, "not_found");
      // ⚠️ Отдаём только то, что нужно по делу: ни accountId, ни uid/папки, ни путей к файлам —
      // иначе маршрут стал бы обходным путём к служебному ящику.
      res.json({
        resolutionId: detail.id,
        emailId,
        subject: mail.subject,
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        date: mail.date,
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
        attachments: listAttachments(emailId).map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size
        }))
      });
    })
  );

  app.get(
    "/api/docflow/tasks/:resolutionId/source-email/attachments/:attachmentId",
    ...taskView,
    asyncHandler(async (req, res) => {
      // Та же проверка связи: вложение достаётся только вместе с правом на это поручение.
      const { emailId } = await sourceEmailOf(req);
      const att = listAttachments(emailId).find((a) => a.id === req.params.attachmentId);
      if (!att || !att.storagePath || !fs.existsSync(att.storagePath)) {
        throw new AppError("Файл не найден", 404, "not_found");
      }
      res.setHeader("Content-Type", att.mimeType);
      res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(att.filename));
      const stream = fs.createReadStream(att.storagePath);
      // Обрыв скачивания: pipe не закрывает чтение — дескриптор остался бы открытым.
      res.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.on("error", (err: Error) => {
        logger.warn({ err: err.message, path: att.storagePath }, "Не удалось прочитать вложение письма-источника");
        if (res.headersSent) res.destroy();
        else res.status(404).json({ error: "Файл не найден" });
      });
      stream.pipe(res);
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
      await assertSignRight(signer.id, "Отправитель письма не имеет права подписи", {
        actor: actorOf(req),
        resolutionId: req.params.id,
        email: from
      });
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

  // ⚠️ Канбан показывает ВСЕ поручения организации — исполнителю здесь нечего делать
  // (у него «Мои задачи»). Право `journal.view` есть у всех ролей, поэтому его мало.
  app.get(
    "/api/docflow/resolutions/board",
    ...prepare,
    asyncHandler(async (_req, res) => {
      res.json(await listBoard());
    })
  );

  // ⚠️ Поручения документа — управленческий вид (карточка документа в журнале).
  // Права journal.view тут мало: оно есть у всех, и исполнитель получал список чужих
  // поручений вместе с текстами и сроками, обходя решение заказчика.
  app.get(
    "/api/docflow/resolutions/by-document/:documentId",
    ...prepare,
    asyncHandler(async (req, res) => {
      res.json(await listDocumentResolutions(req.params.documentId));
    })
  );

  // ⚠️ Список ВСЕХ резолюций — то же самое: чужие сроки, тексты и соисполнители
  // исполнителю не нужны. Решение заказчика 2026-10-05. Проверяется сквозным сценарием
  // (test_resolutions.mjs: «рядовой сотрудник не видит список резолюций»).
  app.get(
    "/api/docflow/resolutions",
    ...prepare,
    asyncHandler(async (req, res) => {
      res.json(
        await listResolutions({
          status: str(req.query.status) as ResolutionStatus | undefined,
          documentId: str(req.query.documentId),
          assigneeId: str(req.query.assigneeId),
          // listResolutions приводит предел к [1, 200]; мусор отсекаем до базы.
          limit: intParam(req.query.limit, "limit", { fallback: 50, min: 1, max: 200 }),
          offset: intParam(req.query.offset, "offset", { fallback: 0, min: 0 })
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
      // Карточка отдаёт текст поручения, срок, историю с комментариями и адреса всех
      // исполнителей — чужому человеку здесь нечего делать.
      assertResolutionVisible(req, detail);
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

  /**
   * ⚠️ Маршрут POST /:id/email-approval УДАЛЁН (D-2, task-14).
   *
   * Он стоял под правом аппарата (resolution.dispatch) и вызывал markEmailApproval, который
   * записывал подписантом САМОГО аппарата: штатным маршрутом обходилось правило «подписант —
   * только обладатель resolution.approve». Веб этот маршрут не использовал — он был чистым
   * вектором обхода. Человеческий путь один: аппарат отмечает письмо через
   * POST /:id/mark-approval, где отправитель письма проверяется правом подписи.

  /** Способ В, шаг 2: аппарат подтвердил разбор и утверждение (Р9). */
  app.post(
    "/api/docflow/resolutions/:id/confirm",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      // Подписанта вписывает аппарат, но право подписи проверяет сервер: без этого
      // подписантом можно было назвать кого угодно — лишь бы он был в базе.
      const approvedBy = b.approvedBy ? String(b.approvedBy) : null;
      if (approvedBy) {
        await assertSignRight(approvedBy, undefined, { actor: actorOf(req), resolutionId: req.params.id });
      }
      res.json(
        await confirmEmailApproval(req.params.id, actorOf(req), {
          approvedBy,
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

      // Тот же помощник, что в /forward: одна логика выбора ящика на оба маршрута.
      const account = await resolveSendAccount(req.user?.id ?? null, b.accountId ? String(b.accountId) : null);

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

      // ⚠️ Порядок шагов зафиксирован решением ведущего: СНАЧАЛА переход в «отправлено»,
      // и только потом письмо. Переход идёт в транзакции с FOR UPDATE (docflow) и служит
      // захватом поручения. Раньше письмо уходило до записи перехода: два одновременных
      // нажатия «Отправить» отправляли исполнителям ДВА письма, а записывалось одно.
      const claimed = await dispatchResolution(req.params.id, actorOf(req), {
        comment: str(b.comment)
      });

      let sent: { emailId: string };
      try {
        sent = await sendEmail({
          accountId: account.id,
          to: withEmail.map((a) => ({ address: a.email, name: a.fullName })),
          subject: "Поручение " + (detail.documentNumber || "") + ": " + detail.text.slice(0, 60),
          bodyText,
          // Ссылаемся на исходное письмо: переписка по делу остаётся одной цепочкой.
          inReplyToEmailId: source?.id ?? null,
          inReplyToMessageId: source?.messageId ?? null,
          references: source?.messageId ? [source.messageId] : []
        });
      } catch (err) {
        // Шаг 4: письмо не ушло — возвращаем поручение в «утверждено», чтобы аппарат
        // мог повторить. Откат тоже может отказать (например, исполнитель уже отчитался),
        // но наружу уходит ИСХОДНАЯ ошибка: аппарат должен узнать про почту, а не про откат.
        await revertDispatch(req.params.id, actorOf(req), "Почтовый сервер не принял письмо: " + (err as Error).message)
          .catch((revertError: Error) => {
            logger.warn(
              { err: revertError.message, resolutionId: req.params.id },
              "Не удалось откатить отправку поручения — поручение осталось в «отправлено»"
            );
            return claimed;
          });
        throw err;
      }

      // Шаг 3: письмо ушло — записываем его идентификатор (журнал и карточка поручения).
      res.json(await attachDispatchEmail(req.params.id, sent.emailId, actorOf(req)));
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
      // Файл календаря несёт текст поручения, срок и номер документа: то же правило,
      // что и у карточки, иначе чужое поручение утекает через .ics.
      assertResolutionVisible(req, detail);
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
      const reported = await reportExecution(
        req.params.id,
        req.user.id,
        { text: String(b.text ?? ""), emailId: b.emailId ? String(b.emailId) : null },
        actorOf(req)
      );
      scheduleStatsRecompute(reported);
      res.json(reported);
    })
  );

  /** Закрытие поручения аппаратом — когда исполнитель отчитался не в приложении. */
  app.post(
    "/api/docflow/resolutions/:id/close",
    ...dispatch,
    asyncHandler(async (req, res) => {
      const comment = String((req.body ?? {}).comment ?? "");
      if (!comment.trim()) throw new AppError("Укажите, на каком основании закрываете", 400, "no_comment");
      const closed = await closeResolution(req.params.id, actorOf(req), comment);
      scheduleStatsRecompute(closed);
      res.json(closed);
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
      // Отчитывается исполнитель: подтвердить отчёт можно только за того, кому поручено.
      // Проверка на сервере — иначе в журнале появится отчёт постороннего человека.
      const detail = await getResolutionDetail(req.params.id);
      if (!detail) throw new AppError("Резолюция не найдена", 404, "not_found");
      if (!detail.assignees.some((a) => a.userId === userId)) {
        throw new AppError("Этот пользователь не исполнитель поручения", 400, "not_assignee");
      }
      const confirmed = await confirmReport(
        req.params.id,
        userId,
        { text: b.text !== undefined ? String(b.text) : undefined },
        actorOf(req)
      );
      scheduleStatsRecompute(confirmed);
      res.json(confirmed);
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