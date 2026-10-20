import { create } from "zustand";
import { api, notificationApi } from "./api";
import { debounce } from "./utils/debounce";
import type {
  Account,
  AiConfig,
  AppNotification,
  AnalysisStatus,
  AuthStatus,
  AuthUser,
  Draft,
  Email,
  EmailView,
  Permission,
  ThreadGroup
} from "./types";
import { humanError } from "./utils/humanError";

export type SortBy = "date" | "priority";
export type SortDir = "asc" | "desc";
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** Разделы приложения: почта и рабочие места документооборота. */
export type AppSection =
  | "mail"
  | "journal"
  | "incoming"
  | "approvals"
  | "confirmation"
  | "tasks"
  | "board";



/** Право, без которого раздел бессмысленен. */
export const SECTION_PERMISSIONS: Record<AppSection, Permission | null> = {
  // Почта — собственные данные работника: права не нужно, доступ решает владелец ящика.
  mail: null,
  journal: "journal.view",
  incoming: "journal.register",
  approvals: "resolution.approve",
  confirmation: "resolution.dispatch",
  tasks: "task.view",
  board: "resolution.create"
};

/** Порядок выбора первого доступного раздела — тот же, что в боковом меню. */
export const SECTION_ORDER: AppSection[] = ["journal", "incoming", "approvals", "confirmation", "tasks", "board"];

/**
 * Раздел, доступный по правам.
 *
 * Раздел не должен переживать смену пользователя: администратор стоял на «На подтверждении»,
 * вошёл исполнитель — и приложение в фоне просило чужие маршруты, а в консоль уходил 403
 * (дефект, найденный QA в браузере). Поэтому при смене пользователя раздел пересматривается,
 * а не восстанавливается как есть: недоступный заменяется первым доступным, иначе — почтой.
 */
export function resolveSection(section: AppSection, can: (permission: Permission) => boolean): AppSection {
  if (section === "mail") return "mail";
  const needed = SECTION_PERMISSIONS[section];
  if (!needed || can(needed)) return section;
  return SECTION_ORDER.find((s) => {
    const need = SECTION_PERMISSIONS[s];
    return need ? can(need) : true;
  }) ?? "mail";
}

export interface FilterState {
  categories: string[];
  minPriority: number | null;
  tag: string | null;
  hasEvent: boolean;
  status: AnalysisStatus | null;
  q: string;
  from: string[];
  to: string[];
  externalNumber: string[];
  dateFrom: string;
  dateTo: string;
  sendDateFrom: string;
  sendDateTo: string;
  sortBy: SortBy;
  sortDir: SortDir;
}

interface State extends FilterState {
  accounts: Account[];
  emails: Email[];
  folder: string;
  accountFilter: string | null;
  selectedId: string | null;
  emailView: EmailView | null;
  selectedIds: string[];
  /** Письмо, для которого нужно сразу открыть форму регистрации (переход из списка «На регистрацию»). */
  registerIntent: string | null;
  /** Документ, который надо открыть в журнале (переход с канбана резолюций). */
  documentIntent: string | null;
  requestDocument: (documentId: string) => void;
  clearDocumentIntent: () => void;
  /** Сколько писем сейчас в очереди анализа: нужно подтверждению «Стоп». */
  analysisQueue: number;
  setAnalysisQueue: (n: number) => void;
  /**
   * Последняя ошибка загрузки (список, письмо): показывается человеку.
   * Без неё сбой сети выглядел как «ничего не произошло», а список молча
   * оставался от прежней папки — человек читал не то, что думал.
   */
  loadError: string | null;
  /**
   * Счётчик запусков анализа: по нему индикатор прогресса понимает, что очередь
   * снова не пуста, и проверяет её немедленно (в простое он опрашивает редко).
   */
  analysisEpoch: number;
  /**
   * Сообщить индикатору, что сервер мог поставить письма в анализ.
   *
   * Нужно действиям, после которых анализ запускается на сервере, а не кнопкой
   * «Анализировать»: скан ящика и импорт .eml (core: auto_analyze → enqueue).
   * Без этого плашка прогресса и кнопка «Стоп» не появлялись.
   */
  wakeAnalysisProgress: () => void;
  loading: boolean;
  settingsOpen: boolean;
  /** Вкладка, которую просят открыть в настройках («Личные настройки», «Подключение»). */
  settingsTab: string | null;
  aiConfig: AiConfig | null;
  compose: {
    open: boolean;
    mode: ComposeMode;
    emailId: string | null;
    draft: Draft | null;
    /**
     * Письмо по документу СЭД: тема и текст предзаполнены, человек их правит.
     * После отправки письмо связывается с поручением (заказчик: «отправляете молча»).
     */
    edms?: { documentId: string; subject: string; bodyText: string } | null;
  };
  openCompose: (mode: ComposeMode, emailId?: string | null) => void;
  /** Открыть окно письма с готовым текстом по документу (аппарат правит и отправляет сам). */
  openEdmsCompose: (input: { documentId: string; subject: string; bodyText: string }) => void;
  /** Открыть композер с уже сохранённым черновиком. */
  openDraftCompose: (draft: Draft) => void;
  closeCompose: () => void;
  draftsOpen: boolean;
  setDraftsOpen: (v: boolean) => void;
  threadView: boolean;
  threads: ThreadGroup[];
  setThreadView: (v: boolean) => void;
  loadThreads: () => Promise<void>;

  // -------- документооборот: вход --------
  /** Состояние входа, известное серверу (включён ли документооборот, настроен ли каталог и т.д.). */
  authStatus: AuthStatus | null;
  /** Текущий пользователь; null — документооборот выключен или вход не выполнен. */
  authUser: AuthUser | null;
  /** Первичная проверка сессии завершена (иначе показываем «загрузку», а не форму входа). */
  authReady: boolean;
  /**
   * Сервер документооборота недоступен. Почта при этом работает: она локальная,
   * поэтому не блокируем приложение, а только прячем функции документооборота.
   */
  docflowUnavailable: boolean;
  /** Нет связи с сервером: показываем экран и не делаем вид, что всё в порядке. */
  connectionLost: boolean;
  setConnectionLost: (value: boolean) => void;
  loadAuth: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: Permission) => boolean;
  /** Доступна ли почта предприятия (T39/T44): учитывает автономный режим. */
  canUseMail: () => boolean;
  /** Можно ли отправлять письма (T39/T44). */
  canSendMail: () => boolean;

  // -------- этап 5: центр уведомлений --------
  /** Загруженные уведомления текущего пользователя (последние сверху — как отдаёт сервер). */
  notifications: AppNotification[];
  /** Сколько всего уведомлений у пользователя: для подписи «Показаны 20 из 137». */
  notificationsTotal: number;
  /** Уведомления включены администратором (А4): иначе честный текст, а не пустой список. */
  notificationsEnabled: boolean;
  /** Число непрочитанных: его показывает бейдж в шапке. */
  unreadCount: number;
  notificationsLoading: boolean;
  /** Ошибка загрузки списка: показывается человеку, а не уходит в консоль. */
  notificationsError: string | null;
  /** 401/403 на опросе: право отозвали — таймер не поднимаем повторно. */
  notificationsForbidden: boolean;
  loadNotifications: (opts?: { unreadOnly?: boolean; limit?: number; append?: boolean }) => Promise<void>;
  /** Дешёвый запрос счётчика — им живёт бейдж (опрос раз в 60 с). */
  refreshUnreadCount: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  /**
   * Запуск и остановка опроса счётчика. Останавливать обязательно при размонтировании,
   * иначе таймер живёт после ухода со страницы (утечка и гонка запросов).
   */
  startNotificationPolling: () => void;
  stopNotificationPolling: () => void;

  init: () => Promise<void>;
  loadAccounts: () => Promise<void>;
  loadAiConfig: () => Promise<void>;
  loadEmails: () => Promise<void>;
  select: (id: string) => Promise<void>;
  /** Просьба открыть форму регистрации для письма: ставится списком, снимается формой. */
  requestRegister: (emailId: string) => void;
  clearRegisterIntent: () => void;
  refreshSelected: () => Promise<void>;
  setFolder: (f: string) => void;
  setAccountFilter: (id: string | null) => void;
  /**
   * Активный раздел приложения. Роутера нет намеренно: разделы СЭД — это
   * состояние, а не адреса (см. журнал решений, «Роутер: отсутствует»).
   */
  section: AppSection;
  setSection: (s: AppSection) => void;
  setFilter: (patch: Partial<FilterState>) => void;
  resetFilters: () => void;
  fetchAccount: (id: string) => Promise<void>;
  analyze: (id: string) => Promise<void>;
  analyzeAll: () => Promise<void>;
  stopAnalysis: () => Promise<void>;
  setSettingsOpen: (v: boolean) => void;
  /** Открыть настройки сразу на нужной вкладке: из отказа отправки человек попадает по делу. */
  openSettings: (tab?: string) => void;
  moveSelected: (folder: string) => Promise<void>;
  updateAnalysis: (patch: Record<string, unknown>) => Promise<void>;
  toggleSelect: (id: string) => void;
  toggleSelectMany: (ids: string[]) => void;
  clearSelection: () => void;
  bulkAnalyze: () => Promise<void>;
  bulkMove: (folder: string) => Promise<void>;
  bulkDelete: () => Promise<void>;
  selectAll: () => void;
  analyzeRange: (since?: string, until?: string, accountIds?: string[]) => Promise<number>;
  fetchAccounts: (ids: string[], since?: string, until?: string) => Promise<void>;
  importEmails: (accountId: string, folder: string, files: { filename: string; data: string }[]) => Promise<{ added: number; skipped: number }>;
  fetchAccountRange: (id: string, since?: string, until?: string) => Promise<void>;
}

/** Единый фильтр для списка писем и переписок (иначе поиск в тредах терялся). */
function filterParams(s: State) {
  return {
    folder: s.folder,
    accountId: s.accountFilter ?? undefined,
    categories: s.categories.length ? s.categories : undefined,
    minPriority: s.minPriority ?? undefined,
    tag: s.tag ?? undefined,
    hasEvent: s.hasEvent,
    status: s.status ?? undefined,
    q: s.q || undefined,
    from: s.from.length ? s.from : undefined,
    to: s.to.length ? s.to : undefined,
    externalNumber: s.externalNumber.length ? s.externalNumber : undefined,
    dateFrom: s.dateFrom || undefined,
    dateTo: s.dateTo || undefined,
    sendDateFrom: s.sendDateFrom || undefined,
    sendDateTo: s.sendDateTo || undefined,
    sortBy: s.sortBy,
    sortDir: s.sortDir
  };
}

/**
 * Письма, которые пользователь видит в списке прямо сейчас.
 *
 * Массовые действия считаются только по ним: иначе «Удалить» уносит письма,
 * которых на экране нет (они остались выбранными от прежнего фильтра).
 */
export function visibleEmailIds(s: {
  emails: Email[];
  threads: ThreadGroup[];
  threadView: boolean;
}): string[] {
  if (s.threadView) return [...new Set(s.threads.flatMap((t) => t.emails.map((e) => e.id)))];
  return s.emails.map((e) => e.id);
}

/** Оставляет в выборе только видимое; если ничего не изменилось — тот же массив. */
function pruneSelection(selectedIds: string[], visible: string[]): string[] {
  const keep = new Set(visible);
  const next = selectedIds.filter((id) => keep.has(id));
  return next.length === selectedIds.length ? selectedIds : next;
}

/**
 * Включён ли фильтр или поиск.
 *
 * Нужно тексту пустого состояния: «нет писем» и «фильтр ничего не нашёл» —
 * разные вещи, и во втором случае человеку надо предложить сбросить фильтр.
 */
export function hasActiveFilter(s: FilterState): boolean {
  return Boolean(
    s.q.trim() ||
      s.tag ||
      s.categories.length ||
      s.status ||
      s.minPriority ||
      s.hasEvent ||
      s.from.length ||
      s.to.length ||
      s.externalNumber.length ||
      s.dateFrom ||
      s.dateTo ||
      s.sendDateFrom ||
      s.sendDateTo
  );
}

/** Выбранное, что реально видно в текущем списке — только по этому и действуем. */
function selectedVisible(s: State): string[] {
  const keep = new Set(visibleEmailIds(s));
  return s.selectedIds.filter((id) => keep.has(id));
}

/** Запрос списка: новый отменяет предыдущий, иначе старый ответ перетрёт свежий. */
let emailsAbort: AbortController | null = null;

/** Раз в минуту — требование §7 контракта; чаще незачем, счётчик дешёвый, но не бесплатный. */
export const NOTIFICATIONS_POLL_MS = 60_000;
/** Единственный таймер опроса: повторный start не должен плодить второй. */
let notificationsTimer: ReturnType<typeof setInterval> | null = null;
/** Номер последнего запроса списка: устаревший ответ не перетирает свежий. */
let notificationsSeq = 0;
/** Номер последнего запроса счётчика: ответ, начатый до «прочитать все», не должен вернуть старый счётчик. */
let unreadSeq = 0;
/** Размер страницы списка уведомлений (stage5-ux.md §2.2). */
export const NOTIFICATIONS_PAGE = 20;

/** 401/403 — это не «сбой сети»: повторять каждую минуту нельзя (А4-подобное требование §2.6). */
function isAuthErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("forbidden") ||
    m.includes("unauthorized") ||
    m.includes("недостаточно прав") ||
    m.includes("требуется вход")
  );
}

/**
 * Перезапрос списка с паузой: поиск идёт по буквам, поэтому «о», «от», «отч»
 * должны превратиться в один запрос, а не в три (и не обогнать друг друга).
 */
const reloadListDebounced = debounce(() => {
  void useStore.getState().loadEmails();
}, 300);
/** То же для открытого письма: быстрое переключение писем не должно подменять открытое. */
let emailAbort: AbortController | null = null;

export const useStore = create<State>()((set, get) => ({
  accounts: [],
  emails: [],
  folder: "INBOX",
  section: "mail",
  accountFilter: null,
  selectedId: null,
  emailView: null,
  selectedIds: [],
  registerIntent: null,
  documentIntent: null,
  analysisQueue: 0,
  loadError: null,
  analysisEpoch: 0,
  loading: false,
  settingsOpen: false,
  settingsTab: null,
  aiConfig: null,
  compose: { open: false, mode: "new", emailId: null, draft: null, edms: null },
  draftsOpen: false,
  threadView: false,
  threads: [],
  categories: [],
  minPriority: null,
  tag: null,
  hasEvent: false,
  status: null,
  q: "",
  from: [],
  to: [],
  externalNumber: [],
  dateFrom: "",
  dateTo: "",
  sendDateFrom: "",
  sendDateTo: "",
  sortBy: "date",
  sortDir: "desc",
  authStatus: null,
  authUser: null,
  authReady: false,
  docflowUnavailable: false,
  connectionLost: false,
  notifications: [],
  notificationsTotal: 0,
  notificationsEnabled: true,
  unreadCount: 0,
  notificationsLoading: false,
  notificationsError: null,
  notificationsForbidden: false,

  loadAuth: async () => {
    try {
      const status = await api.authStatus();
      set({ authStatus: status, docflowUnavailable: false });
      if (!status.docflowEnabled) {
        // Автономный режим: документооборот выключен, входа нет — и разделов СЭД нет.
        set({ authUser: null, authReady: true, section: "mail" });
        return;
      }
      const me = await api.authMe();
      set({ authUser: me.user ?? null, authReady: true });
      // Права могли измениться (другая роль, отозванное право) — раздел пересматриваем.
      set({ section: resolveSection(get().section, get().can) });
    } catch (err) {
      // 503 от прокси = сервер документооборота недоступен. Локальная почта
      // обязана продолжать работать, поэтому не показываем экран входа.
      set({ authUser: null, authStatus: null, authReady: true, docflowUnavailable: true });
      console.warn("Документооборот недоступен:", humanError(err));
    }
  },

  login: async (login, password) => {
    const res = await api.login(login, password);
    set({ authUser: res.user, authReady: true });
    // Смена пользователя: раздел, выбранный прошлым, новому может быть недоступен.
    set({ section: resolveSection(get().section, get().can) });
    await get().init();
  },

  setConnectionLost: (value: boolean) => set({ connectionLost: value }),

  logout: async () => {
    await api.logout();
    // Следующий пользователь не должен наследовать чужой раздел: обнуляем сразу.
    set({ authUser: null, section: "mail", emails: [], emailView: null, selectedId: null, selectedIds: [] });
  },

  can: (permission) => {
    const s = get();
    // Сервер недоступен — функции документооборота недоступны (но почта работает).
    if (s.docflowUnavailable) return false;
    // Документооборот выключен — ограничений нет (автономный режим).
    if (!s.authStatus?.docflowEnabled) return true;
    return !!s.authUser?.permissions.includes(permission);
  },

  /**
   * Почта: в автономном режиме и без документооборота она работает всегда (это обычный
   * почтовый клиент), а при включённом документообороте нужен mail.view.
   * Права берём ровно оттуда же, откуда их берут остальные экраны — из authUser.permissions.
   */
  canUseMail: () => {
    // ⚠️ Права на почту больше НЕ существует: свой ящик и своя почта — собственные данные
    // работника, граница проходит по владельцу ящика на сервере (docs/design/mail-ownership.md).
    // Раньше здесь требовался mail.view, и человек без ролей не мог открыть даже свой ящик.
    return true;
  },

  canSendMail: () => {
    // Отправка идёт со СВОЕГО ящика: сервер проверяет владельца, а не право роли.
    return true;
  },

  loadNotifications: async (opts) => {
    const unreadOnly = !!opts?.unreadOnly;
    const limit = opts?.append ? get().notifications.length + NOTIFICATIONS_PAGE : opts?.limit ?? NOTIFICATIONS_PAGE;
    // Перезапрос (открыли панель дважды) не должен оставлять на экране старый список.
    const seq = ++notificationsSeq;
    set({ notificationsLoading: true });
    try {
      const data = await notificationApi.list({ limit, unreadOnly });
      if (seq !== notificationsSeq) return;
      set({
        notifications: data.items,
        unreadCount: data.unread,
        notificationsTotal: data.total,
        // Если сервер не отдал признак (старая сборка) — считаем, что уведомления включены.
        notificationsEnabled: data.enabled !== false,
        notificationsError: null,
        notificationsForbidden: false
      });
    } catch (err) {
      // Отказ не бросаем наружу (иначе необработанный промис в консоли), а показываем.
      if (seq !== notificationsSeq) return;
      const message = humanError(err);
      set({ notificationsError: message, notificationsForbidden: isAuthErrorMessage(message) });
    } finally {
      if (seq === notificationsSeq) set({ notificationsLoading: false });
    }
  },

  refreshUnreadCount: async () => {
    // Монотонный номер: ответ, начатый ДО «прочитать все», не должен вернуть старый счётчик.
    const seq = ++unreadSeq;
    try {
      const res = await notificationApi.count();
      if (seq !== unreadSeq) return;
      set({ unreadCount: res.unread, notificationsEnabled: res.enabled !== false });
    } catch (err) {
      // Фоновый опрос: сбой не шумит в консоли. Но 401/403 — не «сбой сети»:
      // право отозвали, и ретраить его каждую минуту нельзя.
      if (seq === unreadSeq && isAuthErrorMessage(humanError(err))) {
        set({ notificationsForbidden: true });
        get().stopNotificationPolling();
      }
    }
  },

  markNotificationRead: async (id) => {
    // Счётчик, запрошенный до прочтения, описывает старое состояние — обесцениваем его.
    unreadSeq++;
    const before = get().notifications;
    const prevUnread = get().unreadCount;
    const wasUnread = before.some((n) => n.id === id && !n.readAt);
    // Оптимистично: бейдж не должен «залипать» до ответа сервера (§2.4).
    if (wasUnread) {
      set({
        unreadCount: Math.max(0, prevUnread - 1),
        notifications: before.map((n) =>
          n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n
        )
      });
    }
    try {
      const res = await notificationApi.markRead(id);
      // Счётчик берём из ответа сервера: он знает и о строках, которых нет в загруженной странице.
      if (typeof res?.unread === "number") set({ unreadCount: res.unread });
    } catch (err) {
      // Откат: показанное «прочитано» без записи на сервере — враньё.
      set({ notifications: before, unreadCount: prevUnread });
      throw err;
    }
  },

  markAllNotificationsRead: async () => {
    unreadSeq++;
    const res = await notificationApi.readAll();
    const now = new Date().toISOString();
    set((s) => ({
      unreadCount: typeof res?.unread === "number" ? res.unread : 0,
      notifications: s.notifications.map((n) => (n.readAt ? n : { ...n, readAt: now }))
    }));
  },

  startNotificationPolling: () => {
    const s = get();
    // Автономный режим (документооборот выключен) — уведомлений нет вовсе.
    if (!s.authStatus?.docflowEnabled || !s.authUser) return;
    // Без права колокольчика опрос дал бы 403 в консоли у каждой роли без права.
    if (!s.can("notifications.view")) return;
    // Право отозвали в этой сессии — не поднимаем таймер заново.
    if (s.notificationsForbidden) return;
    // Повторный start (перерисовка компонента) не должен плодить второй таймер.
    if (notificationsTimer) return;
    void get().refreshUnreadCount();
    notificationsTimer = setInterval(() => {
      // Свёрнутая вкладка: тик пропускаем, при возврате компонент дёрнет счётчик сам.
      if (typeof document !== "undefined" && document.hidden) return;
      void get().refreshUnreadCount();
    }, NOTIFICATIONS_POLL_MS);
  },

  stopNotificationPolling: () => {
    if (notificationsTimer) {
      clearInterval(notificationsTimer);
      notificationsTimer = null;
    }
  },

  init: async () => {
    // Список ящиков закрыт правом mail.view (T39): у остальных запрос отвечал 403 и попадал
    // в консоль как ошибка. Проверяем право ДО запроса, а не ловим отказ.
    if (get().canUseMail()) await get().loadAccounts();
    // Настройки ИИ закрыты правом settings.manage: остальным ролям запрос возвращал
    // 403 и попадал в консоль браузера как ошибка.
    if (get().can("settings.manage")) await get().loadAiConfig();
    await get().loadEmails();
  },

  loadAccounts: async () => {
    if (!get().canUseMail()) return;
    const accounts = await api.accounts();
    set({ accounts });
  },

  loadAiConfig: async () => {
    try {
      set({ aiConfig: await api.aiConfig() });
    } catch {
      /* ignore */
    }
  },

  loadEmails: async () => {
    // Без права на почту список не запрашиваем вовсе: раньше это давало пустой экран и 403.
    if (!get().canUseMail()) return;
    // Предыдущий запрос списка больше не нужен: его ответ описывает старый фильтр.
    emailsAbort?.abort();
    const ctrl = new AbortController();
    emailsAbort = ctrl;
    set({ loading: true });
    try {
      const emails = await api.emails(filterParams(get()), { signal: ctrl.signal });
      // Отменённый ответ (или ответ, пришедший после отмены) в стор не попадает.
      if (ctrl.signal.aborted) return;
      set({ emails, loadError: null, selectedIds: pruneSelection(get().selectedIds, emails.map((e) => e.id)) });
      if (get().threadView) {
        try {
          await get().loadThreads();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // Отмена — не ошибка: её запросили мы сами, ответ просто устарел.
      // Настоящий сбой не бросаем наружу (иначе необработанный промис в консоли),
      // а показываем человеку: список мог остаться от прежней папки.
      if (!ctrl.signal.aborted) set({ loadError: humanError(err) });
    } finally {
      if (emailsAbort === ctrl) {
        emailsAbort = null;
        set({ loading: false });
      }
    }
  },

  select: async (id: string) => {
    // Письмо открывается только с правом на почту: исполнитель смотрит письмо-источник
    // отдельным маршрутом task.view (/api/docflow/tasks/:id/source-email).
    if (!get().canUseMail()) return;
    emailAbort?.abort();
    const ctrl = new AbortController();
    emailAbort = ctrl;
    set({ selectedId: id, emailView: null });
    try {
      const emailView = await api.email(id, { signal: ctrl.signal });
      // Пока грузилось, могли открыть другое письмо — старый ответ не наш.
      if (ctrl.signal.aborted || get().selectedId !== id) return;
      set({ emailView, loadError: null });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        console.error(e);
        set({ loadError: "Не удалось открыть письмо: " + humanError(e) });
      }
    }
  },

  refreshSelected: async () => {
    if (!get().canUseMail()) return;
    const id = get().selectedId;
    if (!id) return;
    try {
      const emailView = await api.email(id);
      // Фоновая перечитка не должна возвращать на экран письмо, от которого ушли.
      if (get().selectedId !== id) return;
      set({ emailView });
    } catch {
      /* ignore */
    }
  },

  setFolder: (folder: string) => {
    // Смена папки — смена содержимого списка: прежний выбор к нему не относится.
    set({ folder, selectedIds: [] });
    reloadListDebounced.cancel();
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setAccountFilter: (accountFilter: string | null) => {
    set({ accountFilter, selectedIds: [] });
    reloadListDebounced.cancel();
    void get().loadEmails();
    if (get().threadView) void get().loadThreads();
  },

  setFilter: (patch: Partial<FilterState>) => {
    // Фильтр меняет то, что видно на экране, поэтому выбор сбрасываем:
    // иначе массовое действие уходит на письма, которых пользователь не видит.
    set({ ...patch, selectedIds: [] });
    reloadListDebounced();
  },

  resetFilters: () => {
    set({
      selectedIds: [],
      categories: [],
      minPriority: null,
      tag: null,
      hasEvent: false,
      status: null,
      q: "",
      from: [],
      to: [],
      externalNumber: [],
      dateFrom: "",
      dateTo: "",
      sendDateFrom: "",
      sendDateTo: "",
      sortBy: "date",
      sortDir: "desc"
    });
    reloadListDebounced.cancel();
    void get().loadEmails();
  },

  fetchAccount: async (id: string) => {
    await api.fetchAccount(id);
    // Сервер ставит принятые письма в анализ сам — индикатору нужно об этом сказать.
    get().wakeAnalysisProgress();
    await get().loadEmails();
  },

  analyze: async (id: string) => {
    get().wakeAnalysisProgress();
    await api.analyze(id);
    await get().loadEmails();
  },

  analyzeAll: async () => {
    get().wakeAnalysisProgress();
    await api.analyzeAll();
    await get().loadEmails();
  },

  stopAnalysis: async () => {
    get().wakeAnalysisProgress();
    await api.stopAnalysis();
    await get().loadEmails();
  },

  setSettingsOpen: (v: boolean) => set({ settingsOpen: v, settingsTab: v ? get().settingsTab : null }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  setSection: (section: AppSection) => {
    // Раздел, на который нет прав, не открываем даже программно (переход из уведомления,
    // чужой раздел после смены пользователя): иначе раздел запросит чужие маршруты.
    const needed = SECTION_PERMISSIONS[section];
    if (needed && !get().can(needed)) return;
    set({ section });
  },
  requestRegister: (emailId) => set({ registerIntent: emailId }),
  clearRegisterIntent: () => set({ registerIntent: null }),
  requestDocument: (documentId) => set({ documentIntent: documentId }),
  clearDocumentIntent: () => set({ documentIntent: null }),
  setAnalysisQueue: (n) => set({ analysisQueue: n }),

  openCompose: (mode, emailId = null) => set({ compose: { open: true, mode, emailId, draft: null, edms: null } }),
  openEdmsCompose: (input) =>
    set({ compose: { open: true, mode: "new", emailId: null, draft: null, edms: input } }),
  openDraftCompose: (draft) => set({ compose: { open: true, mode: "new", emailId: null, draft, edms: null } }),
  closeCompose: () => set({ compose: { open: false, mode: "new", emailId: null, draft: null, edms: null } }),
  setDraftsOpen: (v: boolean) => set({ draftsOpen: v }),

  setThreadView: (v: boolean) => {
    set({ threadView: v });
    if (v) void get().loadThreads();
  },
  loadThreads: async () => {
    const threads = await api.threads(filterParams(get()));
    const visible = [...new Set([
      ...get().emails.map((e) => e.id),
      ...threads.flatMap((t) => t.emails.map((e) => e.id))
    ])];
    set({ threads, selectedIds: pruneSelection(get().selectedIds, visible) });
  },

  moveSelected: async (folder: string) => {
    const id = get().selectedId;
    if (!id) return;
    await api.setFolder(id, folder);
    await get().loadEmails();
  },

  updateAnalysis: async (patch: Record<string, unknown>) => {
    const id = get().selectedId;
    if (!id) return;
    await api.updateAnalysis(id, patch);
    await get().refreshSelected();
  },

  toggleSelect: (id: string) => {
    const cur = get().selectedIds;
    set({ selectedIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },

  toggleSelectMany: (ids: string[]) => {
    const cur = get().selectedIds;
    const allSelected = ids.length > 0 && ids.every((id) => cur.includes(id));
    const next = allSelected ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])];
    set({ selectedIds: next });
  },

  clearSelection: () => set({ selectedIds: [] }),

  bulkAnalyze: async () => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    get().wakeAnalysisProgress();
    await api.bulkAnalyze(ids);
    await get().loadEmails();
  },

  bulkMove: async (folder: string) => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    await api.bulkFolder(ids, folder);
    set({ selectedIds: [] });
    await get().loadEmails();
  },

  /**
   * Удаление — необратимое действие, поэтому идём строго по видимым письмам:
   * выбранное «из-под другого фильтра» не должно уехать в корзину.
   */
  bulkDelete: async () => {
    const ids = selectedVisible(get());
    if (!ids.length) return;
    await api.bulkDelete(ids);
    set({ selectedIds: [], selectedId: null, emailView: null });
    await get().loadEmails();
  },

  selectAll: () => {
    set({ selectedIds: visibleEmailIds(get()) });
  },

  analyzeRange: async (since, until, accountIds) => {
    get().wakeAnalysisProgress();
    const r = await api.analyzeRange({ since, until, accountIds });
    await get().loadEmails();
    return r.queued;
  },

  fetchAccounts: async (ids, since, until) => {
    for (const id of ids) {
      await api.fetchAccount(id, { since, until });
    }
    get().wakeAnalysisProgress();
    await get().loadEmails();
  },

  importEmails: async (accountId, folder, files) => {
    const result = await api.importEmails(accountId, folder, files);
    // Импортированные письма уходят в анализ на сервере — иначе о работе не узнать.
    get().wakeAnalysisProgress();
    return result;
  },

  fetchAccountRange: async (id, since, until) => {
    await api.fetchAccount(id, { since, until });
    get().wakeAnalysisProgress();
    await get().loadEmails();
  },

  wakeAnalysisProgress: () => set((s) => ({ analysisEpoch: s.analysisEpoch + 1 }))
}));
