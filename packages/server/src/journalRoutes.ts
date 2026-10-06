import fs from "node:fs";
import type express from "express";
import { buildXlsx, classifyKind, exportFileName, getEmailView, listAttachments, listEmailsWithAnalysis, logger, pdfPageCount } from "@mailsense/core";
import {
  AppError,
  DOCUMENT_STATUSES,
  archivePeriod,
  documentStatusCounts,
  findDuplicates,
  getDocument,
  getDocumentByEmail,
  getNumberingState,
  listArchivedPeriods,
  listCases,
  listCorrespondents,
  listDocumentEmails,
  listDocuments,
  listDocumentsForExport,
  listRegisteredEmailIds,
  linkDocumentEmail,
  peekNextNumber,
  registerDocument,
  saveCase,
  saveCorrespondent,
  saveNumberingRule,
  updateDocument,
  type Actor,
  type DocumentEmailRole,
  type DocumentFilter,
  type DocumentPatch,
  type DocumentSortField,
  type DocumentStatus,
  type Permission
} from "@mailsense/docflow";

/**
 * REST API журнала регистрации (СЭД, этап 2).
 *
 * Вынесено из app.ts отдельным модулем: маршрутов много, а зависимости — те же
 * middleware, что и у остального документооборота.
 */
export interface JournalDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

/** Колонки выгрузки повторяют бумажный журнал. */
export function journalColumns(): Array<{ key: string; title: string; width?: number }> {
  return [
    { key: "n", title: "№ п/п", width: 8 },
    { key: "regNumber", title: "Входящий номер", width: 16 },
    { key: "regDate", title: "Дата регистрации", width: 16 },
    { key: "docNumber", title: "Номер документа", width: 18 },
    { key: "docDate", title: "Дата документа", width: 16 },
    { key: "sender", title: "От кого получен", width: 32 },
    { key: "summary", title: "Краткое содержание", width: 48 },
    { key: "sheetsCount", title: "Кол-во листов", width: 14 },
    { key: "caseNumber", title: "Номер дела", width: 14 },
    { key: "status", title: "Состояние", width: 16 },
    { key: "documentName", title: "Наименование документа", width: 32 }
  ];
}

const STATUS_TITLES: Record<string, string> = {
  new: "Новый",
  on_resolution: "На резолюции",
  in_progress: "На исполнении",
  executed: "Исполнен",
  archived: "В архиве"
};

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

export function docFilterFromQuery(q: Record<string, unknown>): DocumentFilter {
  return {
    search: str(q.search),
    status: str(q.status) as DocumentStatus | undefined,
    period: str(q.period),
    dateFrom: str(q.dateFrom),
    dateTo: str(q.dateTo),
    caseNumber: str(q.caseNumber),
    sort: (str(q.sort) ?? "regNumber") as DocumentSortField,
    order: q.order === "asc" ? "asc" : "desc",
    limit: Number(q.limit) || 50,
    offset: Number(q.offset) || 0
  };
}
export function mountJournalRoutes(app: express.Express, deps: JournalDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const view = [requireDocflowDb, requirePermission("journal.view")];
  const register = [requireDocflowDb, requirePermission("journal.register")];
  const edit = [requireDocflowDb, requirePermission("journal.edit")];
  const manage = [requireDocflowDb, requirePermission("settings.manage")];

  /**
   * Какой номер будет присвоен следующему документу — подсказка для формы.
   *
   * ⚠️ Номер НЕ выдаётся: счётчик не двигается. Настоящий номер даёт база в момент
   * регистрации, поэтому подсказка и показывается как «будет присвоен», а не как поле ввода.
   */
  app.get(
    "/api/docflow/journal/next-number",
    ...register,
    asyncHandler(async (_req, res) => {
      res.json(await peekNextNumber());
    })
  );

  // -------- Нумерация --------
  app.get(
    "/api/docflow/numbering",
    ...view,
    asyncHandler(async (req, res) => {
      const period = typeof req.query.period === "string" ? req.query.period : undefined;
      res.json(await getNumberingState(period));
    })
  );

  app.put(
    "/api/docflow/numbering",
    ...manage,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        await saveNumberingRule(
          {
            stream: String(b.stream ?? "incoming"),
            prefix: String(b.prefix ?? "вх"),
            reset: b.reset === "never" ? "never" : "year",
            template: b.template ? String(b.template) : null
          },
          actorOf(req)
        )
      );
    })
  );

  /** Закрытие года выгрузкой: без этого следующий год не открыть. */
  app.post(
    "/api/docflow/numbering/archive",
    requireDocflowDb,
    requirePermission("journal.archive"),
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const period = String(b.period ?? "");
      if (!/^\d{4}$/.test(period)) throw new AppError("Укажите год выгрузки", 400, "bad_period");
      // ⚠️ Закрыть можно только открытый период: записи архива удалять нечем, поэтому
      // выгруженный год закрыт навсегда. Раньше принимался любой год — случайная выгрузка
      // «2027» при открытом 2026 закрывала год, в котором ещё никто не работал, и открыть
      // его было уже нельзя.
      const state = await getNumberingState();
      const open = state.openPeriod;
      if (!open) {
        throw new AppError("В журнале ещё нет документов — закрывать нечего", 400, "empty_journal");
      }
      if (period !== open) {
        throw new AppError(
          "Закрыть можно только открытый год (" +
            open +
            "): " +
            period +
            " закроется навсегда. Выгрузите журнал за " +
            open +
            ".",
          400,
          "not_open_period"
        );
      }
      const docs = await listDocuments({ period, limit: 1 });
      const file = String(b.fileName ?? exportFileName("journal-" + period));
      await archivePeriod({ period, fileName: file, documentCount: docs.total }, actorOf(req));
      res.json({ ok: true, period, documentCount: docs.total });
    })
  );

  // -------- Справочники --------
  app.get(
    "/api/docflow/cases",
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await listCases(req.query.active === "1"));
    })
  );

  app.post(
    "/api/docflow/cases",
    ...edit,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      if (!String(b.code ?? "").trim()) throw new AppError("Укажите код дела", 400, "bad_code");
      res.json(
        await saveCase(
          {
            id: b.id ? String(b.id) : undefined,
            code: String(b.code),
            title: b.title ? String(b.title) : "",
            isActive: b.isActive !== false,
            sortOrder: Number(b.sortOrder) || 0
          },
          actorOf(req)
        )
      );
    })
  );

  app.get(
    "/api/docflow/correspondents",
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await listCorrespondents(req.query.active === "1"));
    })
  );

  app.post(
    "/api/docflow/correspondents",
    ...edit,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      if (!String(b.name ?? "").trim()) throw new AppError("Укажите наименование", 400, "bad_name");
      res.json(
        await saveCorrespondent(
          {
            id: b.id ? String(b.id) : undefined,
            name: String(b.name),
            shortName: b.shortName ? String(b.shortName) : "",
            inn: b.inn ? String(b.inn) : "",
            isActive: b.isActive !== false
          },
          actorOf(req)
        )
      );
    })
  );

  // -------- Журнал: служебные маршруты идут ДО /:id, иначе Express примет их за id --------
  app.get(
    "/api/docflow/journal/status-counts",
    ...view,
    asyncHandler(async (_req, res) => {
      res.json(await documentStatusCounts());
    })
  );

  /** Проверка дублей перед регистрацией — вызывается формой. */
  app.get(
    "/api/docflow/journal/duplicates",
    ...register,
    asyncHandler(async (req, res) => {
      res.json(
        await findDuplicates({
          emailId: str(req.query.emailId),
          docNumber: str(req.query.docNumber),
          summary: str(req.query.summary)
        })
      );
    })
  );

  app.get(
    "/api/docflow/journal/by-email/:emailId",
    ...view,
    asyncHandler(async (req, res) => {
      res.json((await getDocumentByEmail(req.params.emailId)) ?? null);
    })
  );

  /**
   * «Входящие на регистрацию»: письма ящика, ещё не ставшие документом.
   * Это рабочее место аппарата — список действий, а не обычная почта.
   */
  app.get(
    "/api/docflow/journal/incoming",
    ...register,
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 100, 300);
      const folder = str(req.query.folder) ?? "INBOX";
      const registered = new Set(await listRegisteredEmailIds());
      const emails = listEmailsWithAnalysis({ folder }).filter((e) => !registered.has(e.id));
      const items = emails.slice(0, limit).map((e) => ({
        emailId: e.id,
        accountId: e.accountId,
        subject: e.subject,
        from: e.from,
        date: e.date,
        analysisStatus: e.analysisStatus,
        externalNumber: e.externalNumber,
        sendDate: e.sendDate,
        summary: e.analysis?.summary ?? "",
        priority: e.analysis?.priority ?? null,
        tags: e.analysis?.tags ?? [],
        attachmentsCount: listAttachments(e.id).length
      }));
      res.json({ items, total: emails.length });
    })
  );

  /**
   * Подсказки для формы регистрации: берём из письма и ИИ, чтобы секретарь
   * проверял и дополнял, а не заполнял всё руками.
   */
  app.get(
    "/api/docflow/journal/suggest",
    ...register,
    asyncHandler(async (req, res) => {
      const emailId = String(req.query.emailId ?? "");
      if (!emailId) throw new AppError("Не указано письмо", 400, "bad_email");
      const mail = getEmailView(emailId);
      if (!mail) throw new AppError("Письмо не найдено", 404, "not_found");

      // Количество листов: сумма страниц PDF-вложений; если PDF нет —
      // по числу вложений, иначе поле остаётся пустым для ручного ввода.
      let sheets: number | null = null;
      const pages: number[] = [];
      for (const att of mail.attachments) {
        if (!att.storagePath || !fs.existsSync(att.storagePath)) continue;
        if (classifyKind(att.mimeType, att.filename) !== "pdf") continue;
        try {
          pages.push(await pdfPageCount(fs.readFileSync(att.storagePath)));
        } catch (err) {
          logger.warn({ att: att.filename, err: (err as Error).message }, "Не удалось посчитать страницы PDF");
        }
      }
      if (pages.length) sheets = pages.reduce((a, b) => a + b, 0);
      else if (mail.attachments.length > 0) sheets = mail.attachments.length;

      res.json({
        emailId,
        sender: mail.from ? mail.from.name || mail.from.address : "",
        summary: mail.analysis?.summary || mail.subject || "",
        docNumber: mail.externalNumber ?? "",
        docDate: mail.sendDate ?? "",
        sheetsCount: sheets,
        documentName: mail.subject ?? "",
        alreadyRegistered: (await getDocumentByEmail(emailId))?.regNumber ?? null
      });
    })
  );

  /** Выгрузка журнала в Excel по текущему фильтру — колонки как в бумажном журнале. */
  app.get(
    "/api/docflow/journal/export",
    ...view,
    asyncHandler(async (req, res) => {
      const filter = docFilterFromQuery(req.query as Record<string, unknown>);
      const rows = await listDocumentsForExport(filter);
      const period = filter.period ?? rows[0]?.regPeriod ?? "все-годы";
      const buf = buildXlsx({
        sheetName: "Журнал " + period,
        columns: journalColumns(),
        rows: rows.map((d, i) => ({
          n: i + 1,
          regNumber: d.regNumber,
          regDate: d.regDate,
          docNumber: d.docNumber,
          docDate: d.docDate ?? "",
          sender: d.sender,
          summary: d.summary,
          sheetsCount: d.sheetsCount ?? "",
          caseNumber: d.caseNumber ?? "",
          status: STATUS_TITLES[d.status] ?? d.status,
          documentName: d.documentName
        }))
      });
      const name = exportFileName("journal-" + period);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(name));
      res.send(buf);
    })
  );

  // -------- Журнал: список и регистрация --------
  app.get(
    "/api/docflow/journal",
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await listDocuments(docFilterFromQuery(req.query as Record<string, unknown>)));
    })
  );

  app.post(
    "/api/docflow/journal",
    ...register,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const doc = await registerDocument(
        {
          docNumber: b.docNumber !== undefined ? String(b.docNumber) : undefined,
          docDate: b.docDate ? String(b.docDate) : null,
          sender: b.sender !== undefined ? String(b.sender) : undefined,
          summary: b.summary !== undefined ? String(b.summary) : undefined,
          sheetsCount:
            b.sheetsCount === null || b.sheetsCount === undefined || b.sheetsCount === ""
              ? null
              : Number(b.sheetsCount),
          caseNumber: b.caseNumber ? String(b.caseNumber) : null,
          documentName: b.documentName !== undefined ? String(b.documentName) : undefined,
          correspondentId: b.correspondentId ? String(b.correspondentId) : null,
          emailId: b.emailId ? String(b.emailId) : null,
          regDate: b.regDate ? String(b.regDate) : undefined
        },
        actorOf(req)
      );
      res.status(201).json(doc);
    })
  );

  // -------- Карточка документа --------
  app.get(
    "/api/docflow/journal/:id",
    ...view,
    asyncHandler(async (req, res) => {
      const doc = await getDocument(req.params.id);
      if (!doc) throw new AppError("Документ не найден", 404, "not_found");
      res.json({ ...doc, emails: await listDocumentEmails(doc.id) });
    })
  );

  app.patch(
    "/api/docflow/journal/:id",
    ...edit,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const patch: DocumentPatch = {};
      if (b.docNumber !== undefined) patch.docNumber = String(b.docNumber);
      if (b.docDate !== undefined) patch.docDate = b.docDate ? String(b.docDate) : null;
      if (b.sender !== undefined) patch.sender = String(b.sender);
      if (b.summary !== undefined) patch.summary = String(b.summary);
      if (b.sheetsCount !== undefined) {
        patch.sheetsCount = b.sheetsCount === null || b.sheetsCount === "" ? null : Number(b.sheetsCount);
      }
      if (b.caseNumber !== undefined) patch.caseNumber = b.caseNumber ? String(b.caseNumber) : null;
      if (b.documentName !== undefined) patch.documentName = String(b.documentName);
      if (b.correspondentId !== undefined) {
        patch.correspondentId = b.correspondentId ? String(b.correspondentId) : null;
      }
      if (b.status !== undefined) {
        // ⚠️ Статус — не свободный текст: произвольное значение ломало фильтры журнала
        // и подписи состояния («почти исполнен» никому ничего не говорит). Список берём
        // из docflow, чтобы проверка не разошлась с моделью.
        if (!DOCUMENT_STATUSES.includes(b.status as DocumentStatus)) {
          throw new AppError(
            "Недопустимый статус документа: " +
              String(b.status) +
              ". Допустимо: " +
              DOCUMENT_STATUSES.join(", "),
            400,
            "bad_status"
          );
        }
        patch.status = b.status as DocumentStatus;
      }
      if (b.regDate !== undefined) patch.regDate = String(b.regDate);

      const updated = await updateDocument(req.params.id, patch, actorOf(req));
      if (!updated) throw new AppError("Документ не найден", 404, "not_found");
      res.json(updated);
    })
  );

  /** Привязка письма к делу: резолюция, отчёт об исполнении (этапы 3–4). */
  app.post(
    "/api/docflow/journal/:id/emails",
    ...edit,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const emailId = String(b.emailId ?? "");
      if (!emailId) throw new AppError("Не указано письмо", 400, "bad_email");
      const allowed: DocumentEmailRole[] = ["source", "resolution", "report", "other"];
      const role = allowed.includes(b.role as DocumentEmailRole) ? (b.role as DocumentEmailRole) : "other";
      await linkDocumentEmail(req.params.id, emailId, role, actorOf(req));
      res.json({ ok: true });
    })
  );
}