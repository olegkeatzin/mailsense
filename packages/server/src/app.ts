import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import {
  analyzeAllPending,
  analyzeEmail,
  analyzeEmails,
  analyzeRange,
  cancelAnalysis,
  classifyKind,
  createAccount,
  createDraft,
  draftAttachmentFile,
  deleteTemplate,
  directoryLogin,
  directoryLogout,
  directoryStatus,
  deleteEmails,
  buildXlsx,
  decryptPassword,
  exportFileName,
  fetchEmails,
  getAccountById,
  getTemplate,
  getAccounts,
  listAccounts,
  listAccountsForUser,
  getAccountForUser,
  getAiConfig,
  getEmailView,
  getProgress,
  getPromptSettings,
  importEmails,
  getDraft,
  hasDraftAttachment,
  insertTemplate,
  listAttachments,
  listDrafts,
  listTemplates,
  listEmailsWithAnalysis,
  listThreadsGrouped,
  rebuildThreads,
  removeAccount,
  refreshDirectory,
  renderPreviewImage,
  searchDirectory,
  setAiConfig,
  setEmailFolder,
  setEmailsFolder,
  setLdapSettings,
  setExternalNumber,
  setSendDate,
  setPromptSettings,
  setSettingValue,
  getSettingValue,
  ComposeInputError,
  sendEmail,
  stopAnalysis,
  testAiConnection,
  testConnection,
  testSmtpConnection,
  updateAccountById,
  removeDraft,
  saveDraft,
  updateTemplate,
  upsertAnalysis,
  getAllSettings,
  DraftAttachmentError,
  type Account,
  type AccountInput,
  type AnalysisStatus,
  type Category,
  type ComposeInput,
  type EmailListFilter,
  type ComposeMode,
  type EmailView,
  buildComposeTemplate
} from "@mailsense/core";
import { logger } from "@mailsense/core";
// Серверная часть (документооборот) — отдельный пакет со своей базой.
import {
  SESSION_COOKIE,
  assignRoles,
  authStatus,
  createManualUser,
  getUserWithRoles,
  hasDocflowDb,
  isAppError,
  isDocflowEnabled,
  countAudit,
  listAudit,
  listRoles,
  listUsersWithRoles,
  login,
  logout,
  sessionTtlHours,
  setDocflowEnabled,
  setUserActive,
  syncDirectoryUsers,
  updateManualUser,
  type AuthUser,
  type UserWithRoles,
  hasPermission
} from "@mailsense/docflow";
import {
  attachUser,
  parseCookies,
  requireAdmin,
  requireAnyPermission,
  requireAuth,
  requirePermission,
  requireRemoteSession,
  sessionCookieOptions
} from "./auth.js";
import { mountJournalRoutes } from "./journalRoutes.js";
import { mountResolutionRoutes } from "./resolutionRoutes.js";
import { mountNotificationRoutes } from "./notificationRoutes.js";
import { mountServiceAccountRoutes } from "./serviceAccountRoutes.js";
import { mountMailProfileRoutes } from "./mailProfileRoutes.js";
import { mountEdmsAllowanceRoutes } from "./edmsMailAllowanceRoutes.js";
import { mountMyEdmsMailRoutes } from "./myEdmsMailRoutes.js";
import { mountStatsRoutes } from "./statsRoutes.js";
import { createDocflowProxy } from "./proxy.js";
import { intParam } from "./params.js";

/**
 * Лимиты тела запроса. Тело читается в память целиком, поэтому общий предел жёсткий:
 * 100mb на всех маршрутах означало, что один запрос кладёт процесс. Base64 раздувает
 * вложение примерно на треть, поэтому у письма с вложениями и у импорта .eml — свои,
 * более широкие пределы.
 */
export const BODY_LIMIT = "2mb";
export const ATTACHMENT_BODY_LIMIT = "50mb";
export const IMPORT_BODY_LIMIT = "100mb";

/**
 * Сколько строк аудита выгружаем за один раз. Это предохранитель от выгрузки, которая
 * съест память процесса, а не «страница интерфейса»: до него выгружается ВСЁ.
 */
export const AUDIT_EXPORT_MAX_ROWS = 20000;
/** listAudit отдаёт не больше 1000 записей за раз — ходим страницами этого размера. */
const AUDIT_EXPORT_PAGE = 1000;

function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * У вложения должны быть либо данные, либо ссылка на файл: файл черновика (ref)
 * или вложение письма (emailRef — сервер копирует его сам). Молча отправить письмо
 * без вложения нельзя: человек видит файл в окне и уверен, что он уйдёт.
 *
 * @param needDraftId на отправке ссылка на файл черновика обязана называть сам черновик,
 *   иначе сервер не знает, в каком каталоге искать файл.
 */
function attachmentsError(list: unknown, needDraftId = false): string | null {
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const att = (raw ?? {}) as Record<string, unknown>;
    const hasData = typeof att.data === "string";
    const hasRef = typeof att.ref === "string" && att.ref !== "";
    const hasEmailRef = !!att.emailRef && typeof att.emailRef === "object";
    const ok = hasData || (hasRef && (!needDraftId || (typeof att.draftId === "string" && att.draftId !== ""))) || (!needDraftId && hasEmailRef);
    if (!ok) {
      const name = typeof att.filename === "string" && att.filename ? att.filename : "(без имени)";
      return "Вложение «" + name + "» не загружено — приложите файл заново";
    }
  }
  return null;
}

function accountDto(a: {
  id: string;
  protocol: string;
  host: string;
  port: number;
  tls: string;
  username: string;
  authType: string;
  settings: unknown;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpTls: string | null;
  smtpUsername: string | null;
  smtpAuthType: string | null;
}) {
  return {
    id: a.id,
    protocol: a.protocol,
    host: a.host,
    port: a.port,
    tls: a.tls,
    username: a.username,
    authType: a.authType,
    settings: a.settings,
    smtpHost: a.smtpHost,
    smtpPort: a.smtpPort,
    smtpTls: a.smtpTls,
    smtpUsername: a.smtpUsername,
    smtpAuthType: a.smtpAuthType
  };
}

/**
 * Разбирает query-фильтр списка писем. Используется и для /api/emails,
 * и для /api/threads — иначе поиск/фильтры в режиме «Переписка» игнорируются.
 */
function parseEmailFilter(q: express.Request["query"]): EmailListFilter {
  return {
    folder: (q.folder as string) || undefined,
    accountId: (q.accountId as string) || undefined,
    categories:
      typeof q.categories === "string" && q.categories
        ? (q.categories.split(",").filter(Boolean) as Category[])
        : undefined,
    minPriority: q.minPriority ? Number(q.minPriority) : undefined,
    tag: (q.tag as string) || undefined,
    hasEvent: q.hasEvent === "1",
    status: (q.status as AnalysisStatus) || undefined,
    q: (q.q as string) || undefined,
    from: typeof q.from === "string" && q.from ? q.from.split(",").filter(Boolean) : undefined,
    to: typeof q.to === "string" && q.to ? q.to.split(",").filter(Boolean) : undefined,
    externalNumber:
      typeof q.externalNumber === "string" && q.externalNumber
        ? q.externalNumber.split(",").filter(Boolean)
        : undefined,
    dateFrom: (q.dateFrom as string) || undefined,
    dateTo: (q.dateTo as string) || undefined,
    sendDateFrom: (q.sendDateFrom as string) || undefined,
    sendDateTo: (q.sendDateTo as string) || undefined,
    sortBy: (q.sortBy as "date" | "priority") || undefined,
    sortDir: (q.sortDir as "asc" | "desc") || undefined
  };
}

/** Экранирует спецсимволы для iCalendar (RFC 5545). */
function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** DTO пользователя для UI: хэш пароля и служебные поля наружу не отдаём. */
function userDto(u: UserWithRoles) {
  return {
    id: u.id,
    ldapUid: u.ldapUid,
    email: u.email,
    fullName: u.fullName,
    department: u.department,
    position: u.position,
    managerId: u.managerId,
    phone: u.phone,
    source: u.source,
    // isActive — состояние в каталоге, blocked — ручная блокировка администратором.
    // UI показывает их раздельно, поэтому наружу нужны оба.
    isActive: u.isActive,
    blocked: u.blocked,
    lastLoginAt: u.lastLoginAt,
    roles: u.roles
  };
}

function authUserDto(u: AuthUser) {
  return { ...userDto(u), permissions: u.permissions };
}

export interface CreateAppOptions {
  webDist?: string;
  /**
   * Адрес сервера документооборота. Если задан, локальный backend работает
   * в режиме клиента: почта обслуживается здесь, а журнал/пользователи/резолюции
   * проксируются на сервер. Локальная проверка входа при этом не применяется —
   * аутентификацию выполняет сервер.
   */
  docflowServerUrl?: string | null;
}

export async function createApp(options: CreateAppOptions = {}): Promise<express.Express> {
  const app = express();
  const proxyMode = !!options.docflowServerUrl;

  // CORS. Пока документооборот выключен — поведение 0.1.3 (локальный однопользовательский
  // режим). Как только включается вход, открытый CORS недопустим: SPA и API живут на одном
  // origin, поэтому по умолчанию кросс-доменные запросы не разрешаем вовсе.
  const corsOrigins = (getAllSettings()["security.corsOrigins"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // В режиме клиента локальной базы документооборота нет — спрашивать её нельзя,
  // иначе сервер падает на старте. Источник истины там удалённый сервер.
  const localDocflowEnabled = proxyMode ? false : await isDocflowEnabled();
  if (!localDocflowEnabled && !proxyMode) {
    app.use(cors());
  } else if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  }

  // Прокси ставим ДО express.json: иначе тело запроса будет уже прочитано
  // и до сервера документооборота дойдёт пустым.
  if (proxyMode) {
    app.use(createDocflowProxy({ baseUrl: options.docflowServerUrl! }));
  }

  // Разбор тела: у импорта и у писем с вложениями — свои лимиты, остальное небольшое.
  // body-parser помечает уже разобранный запрос, поэтому общий парсер их не трогает.
  app.use("/api/import", express.json({ limit: IMPORT_BODY_LIMIT }));
  app.use(["/api/emails/send", "/api/drafts"], express.json({ limit: ATTACHMENT_BODY_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));

  // Пользователь сессии + обязательный вход (когда документооборот ведётся локально).
  app.use(attachUser);
  if (proxyMode) {
    // ⚠️ В режиме клиента локальной базы СЭД нет: requirePermission считает документооборот
    // выключенным и пропускает всех. Поэтому локальные маршруты (почта, вложения, настройки,
    // ключ модели) проверяют сессию у того сервера, который её выдал. Пути документооборота
    // сюда не доходят — их обслуживает прокси выше, а авторизует удалённый сервер.
    app.use(requireRemoteSession({ baseUrl: options.docflowServerUrl! }));
  } else {
    app.use(requireAuth);
  }

  // -------- health / settings --------
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "mailsense", time: new Date().toISOString() });
  });

  app.get("/api/settings", requirePermission("settings.manage"), (_req, res) => {
    // ⚠️ Секреты наружу не отдаём: `getAllSettings` возвращает ВСЮ таблицу — включая `ai.apiKey`
    // и зашифрованный пароль каталога, поэтому ключи вырезаем здесь.
    // Чтение настроек предприятия закрыто правом settings.manage (матрица T39): раньше маршрут
    // был открыт любому вошедшему, но настройки — это предприятие, а не личные данные работника.
    // Форма ИИ берёт ключ из `/api/ai/config`, он закрыт тем же правом.
    const all = getAllSettings();
    delete all["ai.apiKey"];
    delete all["ldap.passwordEncrypted"];
    res.json(all);
  });

  app.put("/api/settings", requirePermission("settings.manage"), (req, res) => {
    const body = req.body ?? {};
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") setSettingValue(k, v);
      }
    }
    res.json(getAllSettings());
  });

  // ⚠️ Здесь в ответе `apiKey` — маршрут обязан быть за правом. Раньше был открыт:
  // ключ модели мог прочитать любой вошедший. Рядовому он не нужен — вкладка «ИИ» админская,
  // а в клиенте вызов обёрнут в try/catch (store.ts loadAiConfig), поэтому 403 ничего не ломает.
  app.get("/api/ai/config", requirePermission("settings.manage"), (_req, res) => {
    res.json(getAiConfig());
  });

  app.put("/api/ai/config", requirePermission("settings.manage"), (req, res) => {
    setAiConfig(req.body ?? {});
    res.json(getAiConfig());
  });

  app.get("/api/ai/prompt", requirePermission("settings.manage"), (_req, res) => {
    res.json(getPromptSettings());
  });

  app.put("/api/ai/prompt", requirePermission("settings.manage"), (req, res) => {
    setPromptSettings(req.body ?? {});
    res.json(getPromptSettings());
  });

  app.post(
    "/api/ai/test",
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      const cfg = getAiConfig();
      const baseUrl = (req.body?.baseUrl as string) || cfg.baseUrl;
      const apiKey = (req.body?.apiKey as string) ?? cfg.apiKey;
      const result = await testAiConnection({ baseUrl, apiKey, timeoutMs: cfg.timeoutMs });
      res.json(result);
    })
  );

  app.get("/api/analysis/progress", requirePermission("mail.view"), (_req, res) => {
    res.json(getProgress());
  });

  // -------- accounts --------
  /**
   * Ключ работника для владения ящиками — как у личного профиля почты (Р18): LDAP-логин,
   * а у локального администратора — его id.
   */
  function accountOwnerKey(req: express.Request): string {
    const user = req.user as unknown as { id?: string; ldapUid?: string | null } | null;
    const login = String(user?.ldapUid ?? "").trim();
    return login || String(user?.id ?? "").trim();
  }

  /**
   * Ящики, видимые работнику: только свои.
   *
   * ⚠️ Раньше отдавалась вся таблица `accounts` — в серверном режиме чужую почту можно было
   * читать по accountId, а чужой ящик удалить. Разбор — docs/design/mail-ownership.md.
   * Строки без владельца (созданные до появления владельца) видит администратор настроек:
   * иначе они остались бы бесхозными навсегда.
   */
  function visibleAccounts(req: express.Request): Account[] {
    const mine = listAccountsForUser(accountOwnerKey(req));
    if (!hasPermission(req.user, "settings.manage")) return mine;
    const orphan = listAccounts().filter((a) => !(a.ownerUserId ?? "").trim());
    return [...mine, ...orphan];
  }

  /**
   * Ящик, доступный работнику: свой. Чужой для него не существует (null → 404).
   *
   * ⚠️ Проверяем ТЕМ ЖЕ правилом, что и список (visibleAccounts): иначе бесхозный ящик
   * администратор видел бы, но ни открыть, ни удалить не смог — ровно так выглядел бы
   * «пропавший» ящик после обновления.
   */
  function ownAccount(req: express.Request, id: string): Account | null {
    const account = getAccountById(id);
    if (!account) return null;
    return visibleAccounts(req).some((a) => a.id === id) ? account : null;
  }

  /**
   * Идентификаторы ящиков работника — для фильтра выборки писем.
   * ⚠️ Пустой список в ядре значит «разрешённой почты нет» (пустая выборка), а не «все ящики»:
   * поэтому работник без ящиков не увидит ничего.
   */
  function myAccountIds(req: express.Request): string[] {
    return visibleAccounts(req).map((a) => a.id);
  }

  /** Письмо, доступное работнику: чужое для него не существует (null → 404). */
  function ownEmail(req: express.Request, id: string): EmailView | null {
    const view = getEmailView(id);
    if (!view) return null;
    const mine = new Set(myAccountIds(req));
    return mine.has(view.accountId) ? view : null;
  }

  /** Из присланных идентификаторов оставляем только письма своих ящиков. */
  function ownedEmailIds(req: express.Request, ids: string[]): string[] {
    return ids.filter((id) => ownEmail(req, id) !== null);
  }

  app.get("/api/accounts", (req, res) => {
    res.json(visibleAccounts(req).map(accountDto));
  });

  app.post("/api/accounts", (req, res) => {
    // Свой ящик заводит сам работник: это его личные данные, а не настройка предприятия.
    const input = req.body as AccountInput;
    const account = createAccount(input, accountOwnerKey(req) || null);
    res.status(201).json(accountDto(account));
  });

  app.put("/api/accounts/:id", (req, res) => {
    if (!ownAccount(req, req.params.id)) return res.status(404).json({ error: "Ящик не найден" });
    const input = req.body as AccountInput;
    const updated = updateAccountById(req.params.id, input);
    if (!updated) return res.status(404).json({ error: "Ящик не найден" });
    res.json(accountDto(updated));
  });

  app.delete("/api/accounts/:id", (req, res) => {
    // Удалить можно только свой ящик: чужой не удаляется даже администратором — за общим
    // ящиком сидят разные люди, и «пропавший ящик» оказался бы чужой потерей.
    if (!ownAccount(req, req.params.id)) return res.status(404).json({ error: "Ящик не найден" });
    removeAccount(req.params.id);
    res.json({ ok: true });
  });

  app.post(
    "/api/accounts/test",
    asyncHandler(async (req, res) => {
      const result = await testConnection(req.body as AccountInput);
      res.json(result);
    })
  );

  app.post(
    "/api/accounts/:id/fetch",
    // Забрать новые письма из СВОЕГО ящика — почтовая операция, а не администрирование:
    // права роли тут не нужны, граница проходит по владельцу (регрессия T39 сохранена).
    asyncHandler(async (req, res) => {
      if (!ownAccount(req, req.params.id)) return res.status(404).json({ error: "Ящик не найден" });
      // Ручной скан пользователя: удалённые письма можно скачать заново
      // (авто-скан по-прежнему уважает надгробия — см. scheduler.ts).
      const result = await fetchEmails(req.params.id, {
        since: (req.body?.since as string) || undefined,
        until: (req.body?.until as string) || undefined,
        includeDeleted: true
      });
      res.json(result);
    })
  );

  app.post(
    "/api/import",
    asyncHandler(async (req, res) => {
      const accountId = (req.body?.accountId as string) || "";
      const folder = (req.body?.folder as string) || "INBOX";
      const rawFiles = (req.body?.files as unknown[]) ?? [];
      if (!accountId || rawFiles.length === 0) {
        return res.status(400).json({ error: "Укажите accountId и файлы" });
      }
      if (!ownAccount(req, accountId)) return res.status(404).json({ error: "Ящик не найден" });
      const files = rawFiles
        .filter((f) => f && typeof (f as Record<string, unknown>).filename === "string" && typeof (f as Record<string, unknown>).data === "string")
        .map((f) => {
          const o = f as Record<string, unknown>;
          return { filename: o.filename as string, data: Buffer.from(o.data as string, "base64") };
        });
      const result = await importEmails(accountId, folder, files);
      res.json(result);
    })
  );

  // -------- emails --------
  app.get("/api/emails", (req, res) => {
    const filter = parseEmailFilter(req.query);
    const mine = myAccountIds(req);
    // Явно запрошенный чужой ящик — 404; иначе выборка ограничена своими ящиками.
    if (filter.accountId && !mine.includes(filter.accountId)) {
      return res.status(404).json({ error: "Ящик не найден" });
    }
    res.json(
      listEmailsWithAnalysis({
        ...filter,
        accountIds: filter.accountId ? [filter.accountId] : mine
      })
    );
  });

  app.post("/api/emails/bulk/analyze", (req, res) => {
    const n = analyzeEmails(ownedEmailIds(req, (req.body?.ids as string[]) ?? []));
    res.json({ queued: n });
  });

  // Шаблон письма для ответа/пересылки/нового: получатели, тема, цитата, подпись.
  app.get("/api/compose-template", (req, res) => {
    const accountId = (req.query.accountId as string) || "";
    if (!accountId) return res.status(400).json({ error: "Укажите accountId" });
    const modeRaw = (req.query.mode as string) || "new";
    if (modeRaw !== "new" && modeRaw !== "reply" && modeRaw !== "forward") {
      return res.status(400).json({ error: "Неизвестный режим письма" });
    }
    const mode = modeRaw as ComposeMode;
    const emailId = (req.query.emailId as string) || null;
    // ⚠️ F-5: данные проверяем ДО вызова ядра. Ядро бросает обычное исключение на неизвестный
    // ящик или письмо, а обработчик здесь синхронный — наружу уходил 500 «Внутренняя ошибка»
    // вместо понятного отказа. 500 остаётся только для настоящих сбоев.
    if (!ownAccount(req, accountId)) {
      return res.status(404).json({ error: "Ящик не найден" });
    }
    if (mode !== "new") {
      if (!emailId) return res.status(400).json({ error: "Укажите письмо для ответа или пересылки" });
      if (!getEmailView(emailId)) return res.status(404).json({ error: "Письмо не найдено" });
    }
    // Личная подпись работника (T27): `useAccountSignature=0` — подпись ЯЩИКА не подставляется,
    // её добавит клиент из личных настроек работника. Без параметра поведение прежнее.
    const sig = req.query.useAccountSignature;
    const useAccountSignature =
      sig === undefined ? undefined : !(sig === "0" || sig === "false");
    res.json(
      buildComposeTemplate({
        accountId,
        mode,
        emailId,
        ...(useAccountSignature === undefined ? {} : { useAccountSignature })
      })
    );
  });

  app.get("/api/emails/:id", (req, res) => {
    const view = ownEmail(req, req.params.id);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    res.json(view);
  });

  app.patch("/api/emails/:id/folder", (req, res) => {
    if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
    const folder = (req.body?.folder as string) ?? "INBOX";
    setEmailFolder(req.params.id, folder);
    res.json({ ok: true });
  });

  app.patch("/api/emails/:id/external-number", (req, res) => {
    if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
    const value = typeof req.body?.externalNumber === "string" ? req.body.externalNumber.trim() || null : null;
    setExternalNumber(req.params.id, value);
    res.json({ ok: true, externalNumber: value });
  });

  app.patch("/api/emails/:id/send-date", (req, res) => {
    if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
    const value = typeof req.body?.sendDate === "string" ? req.body.sendDate.trim() || null : null;
    setSendDate(req.params.id, value);
    res.json({ ok: true, sendDate: value });
  });

  app.get("/api/emails/:id/ics", (req, res) => {
    const view = ownEmail(req, req.params.id);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    const eventDate = view.analysis?.eventDate ?? null;
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ error: "У письма нет даты события" });
    }

    const summary = view.subject || "(без темы)";
    const parts = [view.analysis?.summary || ""];
    if (view.externalNumber) parts.push("Внешний номер: " + view.externalNumber);
    if (view.from) parts.push("От: " + (view.from.name || view.from.address));
    const description = parts.filter(Boolean).join("\n");

    const dtstart = eventDate.replace(/-/g, "");
    const end = new Date(eventDate + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 1);
    const dtend = end.toISOString().slice(0, 10).replace(/-/g, "");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MailSense//MailSense//RU",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + view.id + "@mailsense",
      "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z",
      "DTSTART;VALUE=DATE:" + dtstart,
      "DTEND;VALUE=DATE:" + dtend,
      "SUMMARY:" + escapeIcs(summary),
      "DESCRIPTION:" + escapeIcs(description),
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent("event-" + dtstart + ".ics")
    );
    res.send(ics);
  });

  app.post("/api/emails/:id/analyze", (req, res) => {
    if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
    analyzeEmail(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/emails/analyze-all", requirePermission("mail.view"), (req, res) => {
    const n = analyzeAllPending();
    res.json({ queued: n });
  });

  app.post("/api/emails/analyze-range", requirePermission("mail.view"), (req, res) => {
    // Диапазон тоже ограничен своими ящиками: чужой id в запросе не учитываем.
    const allowed = myAccountIds(req);
    const asked = (req.body?.accountIds as string[]) || undefined;
    const n = analyzeRange(
      (req.body?.since as string) || undefined,
      (req.body?.until as string) || undefined,
      asked ? asked.filter((id) => allowed.includes(id)) : allowed
    );
    res.json({ queued: n });
  });

  app.post("/api/emails/analyze-stop", requirePermission("mail.view"), (_req, res) => {
    const cleared = stopAnalysis();
    res.json({ cleared });
  });

  app.post("/api/emails/bulk/folder", (req, res) => {
    const ids = ownedEmailIds(req, (req.body?.ids as string[]) ?? []);
    const folder = (req.body?.folder as string) ?? "INBOX";
    setEmailsFolder(ids, folder);
    res.json({ ok: true });
  });

  app.post(
    "/api/emails/bulk/delete",
    asyncHandler(async (req, res) => {
      const ids = ownedEmailIds(req, (req.body?.ids as string[]) ?? []);
      cancelAnalysis(ids);
      const files: string[] = [];
      for (const id of ids) {
        for (const att of listAttachments(id)) {
          if (att.storagePath && fs.existsSync(att.storagePath)) files.push(att.storagePath);
        }
      }
      const deleted = deleteEmails(ids);
      for (const f of files) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
      res.json({ deleted });
    })
  );

  app.patch("/api/analysis/:emailId", (req, res) => {
    const view = ownEmail(req, req.params.emailId);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    const body = req.body ?? {};
    const current = view.analysis;
    const category = (body.category as Category) ?? current?.category ?? "personal";
    const result = upsertAnalysis({
      emailId: req.params.emailId,
      summary: body.summary ?? current?.summary ?? "",
      tags: body.tags ?? current?.tags ?? [],
      priority: body.priority ?? current?.priority ?? 3,
      urgent: body.urgent ?? current?.urgent ?? false,
      eventDate: body.eventDate ?? current?.eventDate ?? null,
      category,
      rawResponse: current?.rawResponse ?? "",
      modelUsed: current?.modelUsed ?? "",
      attachments: current?.attachments ?? []
    });
    // Категория «спам» → папка «Спам»; перевыбор в другую категорию → «Входящие».
    if (body.category !== undefined && body.category !== current?.category) {
      setEmailFolder(req.params.emailId, category === "spam" ? "SPAM" : "INBOX");
    }
    res.json(result);
  });

  app.get("/api/threads", (req, res) => {
    // Тот же фильтр, что и у списка писем: поиск/категории/даты работают и в переписке.
    // Выборка ограничена своими ящиками — как и в списке писем.
    const filter = parseEmailFilter(req.query);
    const mine = myAccountIds(req);
    if (filter.accountId && !mine.includes(filter.accountId)) {
      return res.status(404).json({ error: "Ящик не найден" });
    }
    res.json(listThreadsGrouped({ ...filter, accountIds: filter.accountId ? [filter.accountId] : mine }));
  });

  // Полная пересборка переписок (на случай, если данные были собраны старой версией).
  app.post("/api/threads/rebuild", (req, res) => {
    const accountId = (req.body?.accountId as string) || undefined;
    const mine = myAccountIds(req);
    if (accountId && !mine.includes(accountId)) return res.status(404).json({ error: "Ящик не найден" });
    // Без accountId пересобираем все СВОИ ящики: чужие не трогаем.
    let rethreaded = 0;
    for (const id of accountId ? [accountId] : mine) rethreaded += rebuildThreads(id);
    res.json({ rethreaded });
  });

  // -------- отправка / черновики --------
  app.post(
    "/api/emails/send",
    asyncHandler(async (req, res) => {
      // Тело запроса и есть `ComposeInput`: поля `fromName` и `replyTo` (Р19) проходят
      // в ядро КАК ЕСТЬ — маршрут их не чистит и не подставляет. Адрес отправителя берётся
      // из ящика (`accountId`), из тела его подменить нельзя — это правило ядра.
      const compose = (req.body ?? {}) as ComposeInput;
      // Отправлять можно только со СВОЕГО ящика: чужой accountId не принимаем.
      if (!compose.accountId || !ownAccount(req, compose.accountId)) {
        return res.status(404).json({ error: "Ящик не найден" });
      }
      const bad = attachmentsError(compose.attachments, true);
      if (bad) return res.status(400).json({ error: bad });
      // Ссылку на файл черновика проверяем ДО отправки: письмо не должно уйти без
      // вложения, которое человек видит в окне (содержимое читает уже ядро).
      for (const att of compose.attachments ?? []) {
        if (att.ref && att.draftId && !hasDraftAttachment(att.draftId, att.ref)) {
          return res
            .status(400)
            .json({ error: "Вложение «" + att.filename + "» не найдено — приложите файл заново" });
        }
      }
      try {
        const result = await sendEmail(compose);
        res.status(201).json(result);
      } catch (err) {
        // Файл мог исчезнуть между проверкой и чтением — это тоже отказ запроса.
        if (err instanceof DraftAttachmentError) return res.status(400).json({ error: err.message });
        // Данные запроса не годятся (имя отправителя, адрес для ответа): это 400 с готовым
        // русским текстом ядра. Показывать человеку «ошибка сервера» здесь нельзя: он не поймёт,
        // что именно поправить в письме.
        if (err instanceof ComposeInputError) return res.status(400).json({ error: err.message });
        throw err;
      }
    })
  );

  app.post(
    "/api/accounts/:id/test-smtp",
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      if (!ownAccount(req, req.params.id)) return res.status(404).json({ error: "Ящик не найден" });
      const result = await testSmtpConnection(req.params.id);
      res.json(result);
    })
  );

  app.get("/api/drafts", (req, res) => {
    res.json(listDrafts((req.query.accountId as string) || undefined));
  });

  app.post("/api/drafts", (req, res) => {
    const d = req.body ?? {};
    const bad = attachmentsError(d.attachments);
    if (bad) return res.status(400).json({ error: bad });
    try {
      // Данные вложений раскладываются в файлы черновика: в JSON остаются ссылки,
      // поэтому автосохранение больше не гоняет base64 каждые 15 секунд.
      const draft = createDraft({
        accountId: d.accountId,
        to: d.to ?? [],
        cc: d.cc ?? [],
        bcc: d.bcc ?? [],
        subject: d.subject ?? "",
        bodyText: d.bodyText ?? "",
        bodyHtml: d.bodyHtml ?? null,
        attachments: d.attachments ?? [],
        inReplyToEmailId: d.inReplyToEmailId ?? null,
        inReplyToMessageId: d.inReplyToMessageId ?? null,
        references: d.references ?? []
      });
      res.status(201).json(draft);
    } catch (err) {
      if (err instanceof DraftAttachmentError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.put("/api/drafts/:id", (req, res) => {
    const d = req.body ?? {};
    const bad = attachmentsError(d.attachments);
    if (bad) return res.status(400).json({ error: bad });
    let draft;
    try {
      draft = saveDraft(req.params.id, {
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyText: d.bodyText,
        bodyHtml: d.bodyHtml,
        attachments: d.attachments,
        inReplyToEmailId: d.inReplyToEmailId,
        inReplyToMessageId: d.inReplyToMessageId,
        references: d.references
      });
    } catch (err) {
      if (err instanceof DraftAttachmentError) return res.status(400).json({ error: err.message });
      throw err;
    }
    if (!draft) return res.status(404).json({ error: "Черновик не найден" });
    res.json(draft);
  });

  app.delete("/api/drafts/:id", (req, res) => {
    // Вместе с черновиком убираем его файлы: иначе каталог drafts/<id> остаётся навсегда.
    removeDraft(req.params.id);
    res.json({ ok: true });
  });

  // Содержимое вложения черновика (файлы лежат в <dataDir>/drafts/<draftId>/).
  app.get(
    "/api/drafts/:id/attachments/:ref/file",
    asyncHandler(async (req, res) => {
      const draft = getDraft(req.params.id);
      const att = draft?.attachments.find((a) => a.ref === req.params.ref);
      if (!att || !att.ref) return res.status(404).json({ error: "Вложение не найдено" });
      const file = draftAttachmentFile(draft!.id, att.ref);
      if (!file) return res.status(404).json({ error: "Файл вложения не найден" });
      const inline = req.query.inline === "1" || /^image\//.test(att.mimeType);
      res.setHeader("Content-Type", att.mimeType);
      res.setHeader(
        "Content-Disposition",
        (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(att.filename)
      );
      const stream = fs.createReadStream(file);
      res.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      // Обрыв скачивания: pipe лишь снимает привязку, поэтому поток закрываем сами —
      // иначе дескриптор остаётся открытым до конца процесса. Проверять это надо по
      // stream.closed: на Windows переименование открытого файла проходит (FILE_SHARE_DELETE).
      // Файл мог исчезнуть между проверкой и открытием: без обработчика это падение процесса.
      stream.on("error", (err: Error) => {
        logger.warn({ err: err.message, path: file }, "Не удалось прочитать файл вложения черновика");
        if (res.headersSent) res.destroy();
        else res.status(404).json({ error: "Файл вложения не найден" });
      });
      stream.pipe(res);
    })
  );

  // -------- directory (LDAP/AD: адресная книга) --------
  app.get("/api/directory/status", (_req, res) => {
    res.json(directoryStatus());
  });

  app.put(
    "/api/directory/settings",
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      res.json(await setLdapSettings(req.body ?? {}));
    })
  );

  app.post(
    "/api/directory/login",
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      res.json(await directoryLogin(String(b.login ?? ""), String(b.password ?? "")));
    })
  );

  app.post(
    "/api/directory/logout",
    requirePermission("settings.manage"),
    asyncHandler(async (_req, res) => {
      res.json(await directoryLogout());
    })
  );

  app.post(
    "/api/directory/refresh",
    requirePermission("settings.manage"),
    asyncHandler(async (_req, res) => {
      res.json({ synced: await refreshDirectory() });
    })
  );

  app.get(
    "/api/contacts/search",
    asyncHandler(async (req, res) => {
      const limit = intParam(req.query.limit, "limit", { fallback: 25, min: 1, max: 50 });
      res.json(await searchDirectory(String(req.query.q ?? ""), limit));
    })
  );

  // -------- templates (шаблоны писем) --------
  app.get("/api/templates", (req, res) => {
    res.json(listTemplates((req.query.accountId as string) || undefined));
  });

  app.post("/api/templates", (req, res) => {
    const t = req.body ?? {};
    if (!t.name) return res.status(400).json({ error: "Укажите название шаблона" });
    res.status(201).json(
      insertTemplate({
        accountId: t.accountId ?? null,
        name: String(t.name),
        subject: t.subject ?? "",
        bodyText: t.bodyText ?? "",
        bodyHtml: t.bodyHtml ?? null
      })
    );
  });

  app.put("/api/templates/:id", (req, res) => {
    const t = req.body ?? {};
    const tpl = updateTemplate(req.params.id, {
      accountId: t.accountId,
      name: t.name,
      subject: t.subject,
      bodyText: t.bodyText,
      bodyHtml: t.bodyHtml
    });
    if (!tpl) return res.status(404).json({ error: "Шаблон не найден" });
    res.json(tpl);
  });

  app.delete("/api/templates/:id", (req, res) => {
    deleteTemplate(req.params.id);
    res.json({ ok: true });
  });

  // -------- attachments --------
  app.get(
    "/api/emails/:id/attachments/:attId/file",
    asyncHandler(async (req, res) => {
      // Вложения чужого письма не отдаём: проверка владельца ДО чтения файла.
      if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
      const atts = listAttachments(req.params.id);
      const att = atts.find((a) => a.id === req.params.attId);
      if (!att || !att.storagePath || !fs.existsSync(att.storagePath)) {
        return res.status(404).json({ error: "Файл не найден" });
      }
      const inline = req.query.inline === "1" || /^image\//.test(att.mimeType);
      res.setHeader("Content-Type", att.mimeType);
      if (inline) {
        res.setHeader("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(att.filename));
      } else {
        res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(att.filename));
      }
      const stream = fs.createReadStream(att.storagePath);
      // ⚠️ Обрыв скачивания: pipe лишь снимает привязку к ответу, но чтение не закрывает —
      // дескриптор оставался открытым до конца процесса. Клиент ушёл → уничтожаем поток.
      res.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      // Файл мог исчезнуть между existsSync и открытием: письмо удаляют, вложение
      // чистят. Без обработчика ошибок это необработанное исключение — сервер падает.
      stream.on("error", (err: Error) => {
        logger.warn({ err: err.message, path: att.storagePath }, "Не удалось прочитать файл вложения");
        if (res.headersSent) res.destroy();
        else res.status(404).json({ error: "Файл не найден" });
      });
      stream.pipe(res);
    })
  );

  app.get(
    "/api/emails/:id/attachments/:attId/preview",
    asyncHandler(async (req, res) => {
      // Вложения чужого письма не отдаём: проверка владельца ДО чтения файла.
      if (!ownEmail(req, req.params.id)) return res.status(404).json({ error: "Письмо не найдено" });
      const atts = listAttachments(req.params.id);
      const att = atts.find((a) => a.id === req.params.attId);
      if (!att || !att.storagePath || !fs.existsSync(att.storagePath)) {
        return res.status(404).json({ error: "Вложение не найдено" });
      }
      const kind = classifyKind(att.mimeType, att.filename);
      const page = intParam(req.query.page, "page", { fallback: 1, min: 1 });
      const content = fs.readFileSync(att.storagePath);
      const buf = await renderPreviewImage(kind, content, page);
      if (!buf) return res.status(415).json({ error: "Предпросмотр недоступен для этого типа" });
      res.setHeader("Content-Type", kind === "pdf" ? "image/png" : att.mimeType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(buf);
    })
  );

  // -------- Документооборот: вход, выход, текущий пользователь --------
  app.get(
    "/api/auth/status",
    asyncHandler(async (_req, res) => {
      res.json(await authStatus());
    })
  );

  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      if (!(await isDocflowEnabled())) {
        // Иначе пользователь получал бы невнятную ошибку подключения к каталогу.
        return res.status(400).json({ error: "Документооборот выключен — вход в систему не требуется" });
      }
      const b = req.body ?? {};
      const result = await login({
        login: String(b.login ?? ""),
        password: String(b.password ?? ""),
        userAgent: String(req.headers["user-agent"] ?? ""),
        ip: req.ip ?? ""
      });
      const ttlMs = (await sessionTtlHours()) * 60 * 60 * 1000;
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions(req, ttlMs));
      res.json({ user: authUserDto(result.user), expiresAt: result.expiresAt });
    })
  );

  app.post(
    "/api/auth/logout",
    asyncHandler(async (req, res) => {
      await logout(req.sessionToken ?? parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null);
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.json({ ok: true });
    })
  );

  app.get(
    "/api/auth/me",
    asyncHandler(async (req, res) => {
      // ⚠️ База не ответила при проверке сессии: ответить «user: null» — значит выбросить
      // человека на экран входа из-за сбоя связи. По 503 клиент прячет только функции СЭД,
      // а локальная почта продолжает работать (store.loadAuth).
      if (req.authLookupError) {
        return res
          .status(503)
          .json({ error: "База документооборота недоступна: " + req.authLookupError.message });
      }
      if (!req.user) {
        // Документооборот выключен либо вход не выполнен: клиент решает сам.
        return res.json({ docflowEnabled: await isDocflowEnabled(), user: null });
      }
      res.json({ docflowEnabled: true, user: authUserDto(req.user) });
    })
  );

  // -------- Документооборот: настройки --------
  app.put(
    "/api/docflow/settings",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      if (b.enabled !== undefined) await setDocflowEnabled(!!b.enabled);
      if (b.sessionTtlHours !== undefined) setSettingValue("auth.sessionTtlHours", String(b.sessionTtlHours));
      if (b.localLoginEnabled !== undefined) {
        setSettingValue("auth.localLoginEnabled", b.localLoginEnabled ? "true" : "false");
      }
      res.json(await authStatus());
    })
  );

  /**
   * Маршруты документооборота требуют настроенной базы. Без неё приложение работает
   * как почтовый клиент, и вместо невнятной 500 отвечаем понятной 503.
   */
  const requireDocflowDb: express.RequestHandler = (_req, res, next) => {
    if (!hasDocflowDb()) {
      res.status(503).json({ error: "Документооборот не настроен: задайте DOCFLOW_DATABASE_URL" });
      return;
    }
    next();
  };

  // -------- Документооборот: роли --------
  app.get(
    "/api/roles",
    requireDocflowDb,
    requirePermission("journal.view"),
    asyncHandler(async (_req, res) => {
      res.json(await listRoles());
    })
  );

  // -------- Документооборот: пользователи и роли --------
  app.get(
    "/api/users",
    requireDocflowDb,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const list = await listUsersWithRoles({
        q: (req.query.q as string) || undefined,
        roleId: (req.query.roleId as string) || undefined,
        includeInactive: req.query.includeInactive === "1"
      });
      res.json(list.map(userDto));
    })
  );

  app.post(
    "/api/users",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const created = await createManualUser(
        {
          email: String(b.email ?? ""),
          fullName: b.fullName,
          department: b.department,
          position: b.position,
          phone: b.phone,
          roleIds: Array.isArray(b.roleIds) ? (b.roleIds as string[]) : []
        },
        req.user
      );
      res.status(201).json(userDto(created));
    })
  );

  app.patch(
    "/api/users/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const u =
        b.isActive !== undefined
          ? await setUserActive(req.params.id, !!b.isActive, req.user)
          : await updateManualUser(
              req.params.id,
              { fullName: b.fullName, department: b.department, position: b.position, phone: b.phone, email: b.email },
              req.user
            );
      const full = await getUserWithRoles(u.id);
      res.json(userDto(full ?? { ...u, roles: [] }));
    })
  );

  app.put(
    "/api/users/:id/roles",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const roleIds = Array.isArray(req.body?.roleIds) ? (req.body.roleIds as string[]) : [];
      res.json(userDto(await assignRoles(req.params.id, roleIds, req.user)));
    })
  );

  app.post(
    "/api/users/sync",
    requireAdmin,
    asyncHandler(async (req, res) => {
      res.json(await syncDirectoryUsers(req.user));
    })
  );

  // -------- Документооборот: аудит --------
  app.get(
    "/api/audit",
    requireDocflowDb,
    requirePermission("audit.view"),
    asyncHandler(async (req, res) => {
      const filter = {
        userId: (req.query.userId as string) || undefined,
        entityType: (req.query.entityType as string) || undefined,
        entityId: (req.query.entityId as string) || undefined,
        action: (req.query.action as string) || undefined,
        dateFrom: (req.query.dateFrom as string) || undefined,
        dateTo: (req.query.dateTo as string) || undefined,
        // Число из query уходит в SQL: мусор должен стать 400, а не LIMIT NaN.
        limit: intParam(req.query.limit, "limit", { fallback: 200, min: 1, max: 1000 }),
        offset: intParam(req.query.offset, "offset", { fallback: 0, min: 0 })
      };
      res.json({ entries: await listAudit(filter), total: await countAudit(filter) });
    })
  );

  /**
   * Выгрузка следов аудита в Excel. Нужна, когда разбирают инцидент:
   * «кто менял этот документ» удобнее читать таблицей, чем списком в UI.
   */
  app.get(
    "/api/audit/export",
    requireDocflowDb,
    requirePermission("audit.view"),
    asyncHandler(async (req, res) => {
      const filter = {
        userId: (req.query.userId as string) || undefined,
        entityType: (req.query.entityType as string) || undefined,
        entityId: (req.query.entityId as string) || undefined,
        action: (req.query.action as string) || undefined,
        dateFrom: (req.query.dateFrom as string) || undefined,
        dateTo: (req.query.dateTo as string) || undefined
      };
      // ⚠️ Раньше выгрузка была жёстко обрезана первой тысячей записей и молчала об этом:
      // файл выглядел полным, а части следа в нём не было. Система заведена ради вопроса
      // «кто внёс данные неверно», поэтому выгружаем ВСЁ — постранично, — а если сработал
      // предохранитель, говорим об этом прямо в файле и в заголовках ответа.
      const total = await countAudit(filter);
      const rows: Array<Record<string, unknown>> = [];
      const limit = Math.min(total, AUDIT_EXPORT_MAX_ROWS);
      for (let offset = 0; offset < limit; offset += AUDIT_EXPORT_PAGE) {
        const page = await listAudit({ ...filter, limit: AUDIT_EXPORT_PAGE, offset });
        rows.push(
          ...page.map((e) => ({
            createdAt: e.createdAt,
            userName: e.userName,
            action: e.action,
            entityType: e.entityType,
            entityId: e.entityId,
            oldValue: e.oldValue ?? "",
            newValue: e.newValue ?? ""
          }))
        );
        if (page.length < AUDIT_EXPORT_PAGE) break;
      }

      const exported = rows.length;
      const truncated = exported < total;
      if (truncated) {
        logger.warn(
          { exported, total, max: AUDIT_EXPORT_MAX_ROWS },
          "Выгрузка аудита неполная: сработал предохранитель"
        );
        // Первая строка файла — предупреждение: его видно сразу, до чтения самих следов.
        rows.unshift({
          createdAt: "⚠️ ВЫГРУЗКА НЕПОЛНАЯ",
          userName: "",
          action:
            "Показано " + exported + " из " + total + " записей, пропущено " + (total - exported),
          entityType: "",
          entityId: "",
          oldValue: "Сузьте фильтр (период, пользователь, объект) и выгрузите снова",
          newValue: ""
        });
      }

      const buf = buildXlsx({
        sheetName: "Аудит",
        columns: [
          { key: "createdAt", title: "Когда", width: 24 },
          { key: "userName", title: "Кто", width: 24 },
          { key: "action", title: "Действие", width: 26 },
          { key: "entityType", title: "Объект", width: 16 },
          { key: "entityId", title: "Идентификатор объекта", width: 38 },
          { key: "oldValue", title: "Было", width: 40 },
          { key: "newValue", title: "Стало", width: 40 }
        ],
        rows
      });
      const name = exportFileName("audit");
      // Заголовки для тех, кто качает файл скриптом: полнота выгрузки видна без открытия.
      res.setHeader("X-Export-Rows", String(exported));
      res.setHeader("X-Export-Total", String(total));
      res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(name));
      res.send(buf);
    })
  );

  // -------- Документооборот: журнал регистрации (этап 2) --------
  mountJournalRoutes(app, { requireDocflowDb, requirePermission, asyncHandler });
  mountResolutionRoutes(app, { requireDocflowDb, requirePermission, requireAnyPermission, asyncHandler });
  // Центр уведомлений и правила автосортировки (этап 5). Служебные пути внутри модуля
  // объявлены до /:id — иначе Express примет «count» и «settings» за идентификатор.
  mountNotificationRoutes(app, { requireDocflowDb, requirePermission, requireAnyPermission, asyncHandler });
  // Служебный ящик отправки (Р12): параметры — аппарату, смена — администратору с аудитом.
  mountServiceAccountRoutes(app, { requireDocflowDb, requirePermission, asyncHandler });
  // Личный выбор «почты для СЭД» (Р24): доступен любому вошедшему и только за себя.
  mountMyEdmsMailRoutes(app, { requireDocflowDb, asyncHandler });
  // Выдача «почты для СЭД» (task-56) — решение администратора, право settings.manage.
  mountEdmsAllowanceRoutes(app, { requireDocflowDb, requirePermission, asyncHandler });
  // Личный профиль почты (T34/T35): локальный маршрут, в проксирование не входит.
  mountMailProfileRoutes(app, { asyncHandler });
  // Агрегат «профиль исполнителя» (task-18): данные под будущую подсказку, читает только админ.
  mountStatsRoutes(app, { requireDocflowDb, requirePermission, asyncHandler });

  // Ответ руководителя распознаётся сразу после синхронизации ящика: письмо приходит
  // в тред, резолюция переходит в «ждёт подтверждения», аппарат видит её в своей очереди.
  // ⚠️ Автоматического разбора писем НЕТ и не должно быть: что ответ руководителя, а что отчёт
  // исполнителя, определяет аппарат, открыв письмо в почте. ИИ лишь помогает заполнить поля.
  // Прежняя подписка на скан (`installApprovalReplyHook`) убрана — она решала за человека.

  // -------- static SPA (собранный web) --------
  const webDist = options.webDist;
  if (webDist && fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // -------- error handler --------
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // Ожидаемые отказы (неверный пароль, нет прав, каталог не настроен) отдаём
      // их статусом и текстом; всё остальное — 500 без внутренних деталей.
      if (isAppError(err)) {
        logger.warn({ err: err.message, status: err.status }, "Отказ API");
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      // Отказы разбора тела (слишком большой запрос, битый JSON) приходят от body-parser
      // со своим статусом: это ошибка клиента, а не сбой сервера.
      const httpStatus =
        (err as { status?: number; statusCode?: number }).status ??
        (err as { statusCode?: number }).statusCode;
      if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500) {
        logger.warn({ err: err.message, status: httpStatus }, "Отказ API");
        return res
          .status(httpStatus)
          .json({ error: httpStatus === 413 ? "Тело запроса слишком велико" : "Некорректный запрос" });
      }
      logger.error({ err: err.message, stack: err.stack }, "Ошибка API");
      // ⚠️ Наружу — только обобщённый текст: сообщение исключения выдаёт пути к файлам
      // и устройство базы. Разбираться по логу.
      res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
  );

  return app;
}

export { decryptPassword };