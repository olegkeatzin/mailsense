import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type express from "express";
import { intParam } from "./params.js";
import {
  buildXlsx,
  classifyKind,
  countAttachmentsByEmail,
  exportFileName,
  getEmailView,
  listAttachments,
  listEmailsWithAnalysis,
  logger,
  matchSortRules,
  pdfPageCount,
  type EmailListItem,
  type MailSortInput,
  type MailSortRule
} from "@mailsense/core";
import {
  AppError,
  DOCUMENT_STATUSES,
  archivePeriod,
  documentStatusCounts,
  findDuplicates,
  EDMS_WORK_ACCOUNT_SETTING,
  getDocument,
  getDocumentByEmail,
  getExternalAccountId,
  getNumberingState,
  getServiceAccountId,
  getUserSetting,
  listArchivedPeriods,
  listCases,
  listCorrespondents,
  listDocumentEmails,
  listDocuments,
  resolutionsByDocument,
  listDocumentsForExport,
  listRegisteredEmailIds,
  listSortRules,
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
import {
  archiveFailureText,
  closePeriod,
  exportJournalYear,
  exportPeriodArchive,
  getDocflowPool,
  importJournalArchive,
  reopenPeriod,
  setJournalAttachmentStore
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

/**
 * Ящики, письма которых участвуют в СЭД: служебные (внутренний отправки + внешняя приёмная)
 * и ЛИЧНЫЙ рабочий ящик работника («почта для СЭД», ключ edms.workAccountId — настройка
 * личная, поэтому берём её у того, кто смотрит очередь).
 *
 * ⚠️ Пустой результат — это «почты для СЭД нет вовсе», и очередь тогда ПУСТАЯ, а не «все
 * ящики системы»: иначе обычные внешние ящики (Яндекс по IMAP и т.п.) попадут аппарату
 * в очередь регистрации, хотя к документообороту отношения не имеют.
 */
export async function edmsAccountScope(userId?: string | null): Promise<string[]> {
  const [service, external, work] = await Promise.all([
    getServiceAccountId(),
    getExternalAccountId(),
    // Без работника личную настройку не подставляем: чужой ящик в чужой очереди — утечка.
    userId ? getUserSetting(String(userId), EDMS_WORK_ACCOUNT_SETTING) : Promise.resolve(null)
  ]);
  const ids = [service, external, work]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
  return [...new Set(ids)];
}

/**
 * Письма ящика, ещё не ставшие документом.
 *
 * ⚠️ Одно место для «Входящих на регистрацию» и предпросмотра правил сортировки:
 * два списка с одинаковым смыслом разошлись бы, и правило в предпросмотре
 * «ловило» бы не те письма, что видит аппарат. Здесь же — и фильтр по почте СЭД:
 * второй реализации состава ящиков быть не должно.
 */
export async function unregisteredInbox(folder = "INBOX", userId?: string | null): Promise<EmailListItem[]> {
  const registered = new Set(await listRegisteredEmailIds());
  const accountIds = await edmsAccountScope(userId);
  return listEmailsWithAnalysis({ folder, accountIds }).filter((e) => !registered.has(e.id));
}

/** Человек как строка для матчинга: имя и адрес — правило ищет подстроку в обоих. */
export function personText(person: { name?: string; address?: string } | null | undefined): string {
  return [person?.name, person?.address].filter(Boolean).join(" ");
}

/**
 * Поля письма для матчинга правил — ЗАМОРОЖЕННЫЙ вход `matchSortRules` (§5).
 * Матчинг делает core: здесь только приведение письма к его входу, без второй реализации.
 */
export function mailSortInput(email: EmailListItem): MailSortInput {
  return {
    from: personText(email.from),
    to: (email.to ?? []).map(personText).join(" "),
    subject: email.subject ?? ""
  };
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
    // Числа уходят в SQL: «?limit=abc» обязан стать 400, а не LIMIT NaN.
    limit: intParam(q.limit, "limit", { fallback: 50, min: 1, max: 1000 }),
    offset: intParam(q.offset, "offset", { fallback: 0, min: 0 })
  };
}
/**
 * Источник вложений для архива: вложения живут в почтовой базе (core), а формат архива
 * и ZIP — в docflow. Раньше регистрации не было ВООБЩЕ, и рабочий сервер собирал архив
 * БЕЗ папки attachments, молча показывая 0 вложений: тихая потеря для заказчика.
 * Регистрируем в композиционном корне — там, где сходятся оба пакета.
 */
type AttachmentView = { name: string; size?: number; open: () => NodeJS.ReadableStream };
let currentStore: { list: (emailId: string) => Promise<AttachmentView[]> } | null = null;

/** Источник вложений, зарегистрированный для архива (нужен расчёту объёма года). */
export function journalAttachmentStore(): { list: (emailId: string) => Promise<AttachmentView[]> } | null {
  // Регистрация идемпотентна и обязана быть к моменту использования: если композиция
  // ещё не зарегистрировала источник (или тест не поднимал приложение), делаем это здесь.
  // Так «архив без вложений молча» становится невозможным по построению.
  if (!currentStore) registerJournalAttachments();
  return currentStore;
}

export function registerJournalAttachments(): void {
  setJournalAttachmentStore({
    list: async (emailId: string) => {
      let files: Array<{ filename: string; size: number; storagePath: string | null }> = [];
      try {
        files = (listAttachments(emailId) ?? []) as typeof files;
      } catch {
        // Почта ещё не инициализирована (режим клиента) — вложений просто нет.
        return [];
      }
      return files
        .filter((a) => !!a.storagePath && fs.existsSync(a.storagePath))
        .map((a) => ({
          name: a.filename || path.basename(a.storagePath as string),
          // Размер из метаданных: он нужен предупреждению о размере архива.
          size: a.size,
          open: () => fs.createReadStream(a.storagePath as string)
        }));
    }
  } as never) as never;
  // Тот же источник, что ушёл в docflow: геттер обязан отдавать ПОЛНЫЙ вид (с open()),
  // иначе расчёт объёма получит урезанный, а тесты проводки — сломанный.
  currentStore = {
    list: async (emailId: string) =>
      (listAttachments(emailId) ?? [])
        .filter((a) => !!a.storagePath && fs.existsSync(a.storagePath))
        .map((a) => ({
          name: a.filename || path.basename(a.storagePath as string),
          size: a.size,
          open: () => fs.createReadStream(a.storagePath as string)
        }))
  };
}

export function mountJournalRoutes(app: express.Express, deps: JournalDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  registerJournalAttachments();
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
      const state = await getNumberingState(period);
      // Предела архива больше нет (Zip64), поэтому и предупреждения о нём нет:
      // предупреждать о несуществующем пределе — врать.
      res.json(state);
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

  /**
   * Выгрузка журнала за год одним файлом.
   *
   * ZIP пишется ПРЯМО в ответ: архив на 10 ГБ не должен собираться в памяти сервера
   * и не должен ждать конца выгрузки — клиент качает потоком.
   */
  app.get(
    "/api/journal/export",
    requireDocflowDb,
    requirePermission("journal.archive"),
    asyncHandler(async (req, res) => {
      const year = String(req.query.year ?? "").trim();
      if (!/^\d{4}$/.test(year)) throw new AppError("Укажите год выгрузки в виде ГГГГ", 400, "bad_period");
      // Источник вложений обязан быть зарегистрирован К МОМЕНТУ выгрузки: без него
      // архив уедет без папки attachments и не скажет об этом. Регистрация идемпотентна,
      // поэтому подтверждаем её прямо здесь, а не надеемся на порядок сборки приложения.
      registerJournalAttachments();
      // Заголовки ставим до первого байта: потом их уже не поменять.
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="journal-' + year + '.zip"');
      try {
        await exportJournalYear({ year, out: res as unknown as NodeJS.WritableStream });
      } catch (err) {
        // Часть архива уже ушла клиенту: ответ не «починить», обрываем соединение.
        logger.error({ err: (err as Error).message, year }, "Выгрузка журнала прервана");
        res.destroy(err as Error);
      }
    })
  );

  /**
   * Импорт архива года: тело запроса — сам ZIP, поэтому json-парсер его не трогает.
   * Пишем во временный файл и удаляем его ВСЕГДА: мусор после ошибки — та же потеря,
   * только на диске.
   */
  app.post(
    "/api/journal/import",
    requireDocflowDb,
    requirePermission("journal.archive"),
    asyncHandler(async (req, res) => {
      const tmp = path.join(os.tmpdir(), "mailsense-journal-import-" + randomUUID() + ".zip");
      let result: Awaited<ReturnType<typeof importJournalArchive>>;
      try {
        await pipeline(req, createWriteStream(tmp));
        result = await importJournalArchive({ file: tmp, actor: actorOf(req) });
      } finally {
        // Файл убираем ДО ответа: иначе клиент успеет увидеть ответ, пока мусор ещё на диске,
        // а при ошибке файл обязан исчезнуть тем же путём.
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      }
      res.json({ ok: true, ...result });
    })
  );

  /**
   * Закрытие года выгрузкой: без этого следующий год не открыть.
   *
   * Три уровня защиты от промаха (заказчик: «а если кто-то случайно год закроет?»):
   *  1) подтверждение ВВОДОМ ГОДА — проверяется здесь, а не только в форме;
   *  2) снимок года ДО необратимого действия — не собрался снимок, нет и закрытия;
   *  3) отмена закрытия, пока в новом году нет документов (маршрут ниже).
   */
  app.post(
    "/api/docflow/numbering/archive",
    requireDocflowDb,
    requirePermission("journal.archive"),
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const period = String(b.period ?? "");
      if (!/^\d{4}$/.test(period)) throw new AppError("Укажите год выгрузки", 400, "bad_period");

      // Подтверждение годом: защита от промаха мышью. «ОК» нажимают не глядя,
      // а чтобы вписать год, человек должен прочитать, ЧТО именно закрывает.
      const confirm = String(b.confirm ?? "").trim();
      if (confirm !== period) {
        throw new AppError(
          "Чтобы закрыть " + period + " год, введите год «" + period + "» в поле подтверждения.",
          400,
          "bad_confirm"
        );
      }

      // ⚠️ Закрыть можно только открытый период: записи архива не удаляются произвольно,
      // поэтому раньше выгруженный год закрывался навсегда. Раньше принимался любой год —
      // случайная выгрузка «2027» при открытом 2026 закрывала год, в котором ещё никто
      // не работал, и открыть его было уже нельзя.
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

      // СНИМОК ПЕРЕД НЕОБРАТИМЫМ ДЕЙСТВИЕМ. Вызывается В ПРОЦЕССЕ (не по своему HTTP):
      // сервер, дергающий сам себя по сети, ломается на таймаутах и в тестах.
      // Не собрался снимок — закрытия не будет вообще: молча закрыть год, не сохранив
      // копию, нельзя.
      let snapshot: string;
      try {
        snapshot = await exportPeriodArchive(period);
      } catch (err) {
        throw new AppError(archiveFailureText((err as Error).message), 409, "snapshot_failed");
      }

      try {
        const closed = await closePeriod(
          { period, fileName: path.basename(snapshot), documentCount: docs.total },
          actorOf(req)
        );
        res.json({ ok: true, period: closed.period, documentCount: closed.documentCount, file: snapshot });
      } catch (err) {
        // Отказ ядра — тоже «год НЕ закрыт», и причина показывается человеку как есть.
        const code = err instanceof AppError ? err.code : "close_failed";
        throw new AppError(archiveFailureText((err as Error).message), 409, code);
      }
    })
  );

  /**
   * Отмена закрытия года — ровно пока в новом году нет ни одного документа.
   *
   * Это не только «откат ошибки»: штатный путь для случая «поздно принесли письмо
   * за прошлый год» — закрытый год документов не принимает, поэтому письмо проводят
   * через отмену закрытия, регистрацию и повторную выгрузку.
   */
  app.post(
    "/api/docflow/numbering/reopen",
    requireDocflowDb,
    requirePermission("journal.reopen"),
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const period = String(b.period ?? "");
      if (!/^\d{4}$/.test(period)) throw new AppError("Укажите год", 400, "bad_period");

      const confirm = String(b.confirm ?? "").trim();
      if (confirm !== period) {
        throw new AppError(
          "Чтобы отменить закрытие " + period + " года, введите год «" + period + "» в поле подтверждения.",
          400,
          "bad_confirm"
        );
      }

      // Причина обязательна: отмена закрытия года — объяснимое действие, но не молчаливое.
      const reason = String(b.reason ?? "").trim();
      if (!reason) throw new AppError("Укажите причину отмены закрытия года", 400, "bad_reason");

      const result = await reopenPeriod({ period, reason }, actorOf(req));
      res.json({ ok: true, period: result.period });
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
      const limit = intParam(req.query.limit, "limit", { fallback: 100, min: 1, max: 300 });
      const folder = str(req.query.folder) ?? "INBOX";
      // А6: пагинации нет, список ограничен limit — total отдаём честно по фильтру.
      const rulesOnly = req.query.rulesOnly === "1";
      const sort = req.query.sort === "rules" ? "rules" : "date";
      const emails = await unregisteredInbox(folder, actorOf(req).id);
      // Правила применяет matchSortRules из core (§6): второй реализации матчинга быть
      // не должно — иначе предпросмотр правила и живой список разойдутся.
      const rules = (await listSortRules()) as MailSortRule[];
      const matched = emails.map((email) => ({ email, match: matchSortRules(rules, mailSortInput(email)) }));

      // Порядок по умолчанию НЕ меняем: аппарат привык к нему, и «улучшение» сортировки
      // молча сдвинуло бы рабочий список. sort=rules — осознанный выбор пользователя.
      const filtered = rulesOnly ? matched.filter((m) => m.match.matched) : matched;
      const ordered =
        sort === "rules"
          ? filtered
              .slice()
              .sort(
                (a, b) =>
                  (b.match.priority ?? -1) - (a.match.priority ?? -1) ||
                  String(b.email.date ?? "").localeCompare(String(a.email.date ?? ""))
              )
          : filtered;
      const page = ordered.slice(0, limit);

      // ⚠️ Вложения считаем ОДНИМ пакетным запросом. Раньше здесь стоял listAttachments
      // на каждое письмо: на 300 писем — 300 запросов в SQLite на один вызов маршрута.
      const attachmentCounts = countAttachmentsByEmail(page.map((m) => m.email.id));
      const items = page.map(({ email: e, match }) => ({
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
        attachmentsCount: attachmentCounts.get(e.id) ?? 0,
        // Поля правил автосортировки (§6). Регистрацию они НЕ заменяют: правило только
        // помечает письмо и подсказывает аппарату, документ по-прежнему создаёт человек.
        sortLabels: match.labels,
        sortPriority: match.priority,
        sortNotes: match.notes,
        sortMatched: match.matched
      }));
      res.json({ items, total: ordered.length });
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
      const page = await listDocuments(docFilterFromQuery(req.query as Record<string, unknown>));
      // Поручение по документу прямо в таблице журнала: резолюция, исполнитель и срок
      // (жалоба заказчика — в карточке видно, в списке нет).
      const briefs = await resolutionsByDocument(page.items.map((d) => d.id));
      res.json({
        ...page,
        items: page.items.map((d) => ({ ...d, resolution: briefs.get(d.id) ?? null }))
      });
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