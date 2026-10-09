/**
 * Выбор ящика отправки и параметры служебного ящика (Р12, решение заказчика; task-11).
 *
 * Раньше и /forward, и /dispatch брали «первый imap-ящик» — на предприятии с несколькими
 * ящиками это угадывание. На стенде им оказался ящик самого директора без SMTP: письмо
 * руководителю либо ушло бы не от того адреса, либо упало бы без объяснения.
 *
 * Приоритет выбора зафиксирован:
 *   явно указанный в теле → служебный из настроек → первый ящик, ГОТОВЫЙ к отправке.
 * Отказ всегда объясняется словами и машинным кодом.
 *
 * ⚠️ «Готов к отправке» — не «заполнен smtp_host», а ровно то, что проверяет отправка:
 * smtp_host есть И есть чем авторизоваться. В core пароль SMTP берётся так
 * (accountService.decryptSmtpPassword): отдельный пароль SMTP, а если его нет — пароль
 * ящика (IMAP/POP3). Ящик с хостом, но без обоих паролей отправку не осилит, и показывать
 * про него «настроено» — это ровно та поздняя ошибка вместо явной, которую мы убираем.
 */
export interface SendAccountLike {
  id: string;
  protocol: string;
  host: string;
  port: number;
  tls: string;
  username: string;
  authType?: string | null;
  /** Пароль ящика в шифре: им же пользуется SMTP, если отдельного пароля нет. */
  passwordEncrypted?: string | null;
  smtpHost: string | null;
  smtpPort?: number | null;
  smtpTls?: string | null;
  smtpUsername?: string | null;
  smtpPasswordEncrypted?: string | null;
}

/**
 * Откуда взят ящик: explicit — из тела запроса, personal — личный выбор работника («почта для СЭД»),
 * service — служебный ящик предприятия. «Первый готовый» (fallback) запрещён решением Р24.
 */
export type SendAccountSource = "explicit" | "personal" | "service" | "none";

/**
 * Машинный код проблемы — UI выбирает по нему кнопку и НЕ парсит русский текст.
 * `ok` — проблемы нет. В ответе GET бывают ok/not_configured/account_missing/
 * smtp_not_configured; unknown_account и no_account — только при отправке.
 */
export type SendAccountProblemCode =
  | "ok"
  /** Служебный ящик снят или не выбран: подставлять «первый попавшийся» нельзя. */
  | "not_configured"
  | "account_missing"
  | "smtp_not_configured"
  | "unknown_account"
  | "no_account"
  /** Явно передан ящик, которым в СЭД отправлять нельзя (Р24): белый список — два ящика. */
  | "account_not_allowed";

export interface SendAccountSelection {
  account: SendAccountLike | null;
  source: SendAccountSource;
  /** Понятная причина, по которой отправлять нельзя; null — можно. Только плоский текст. */
  problem: string | null;
  /** "ok" — можно отправлять. */
  problemCode: SendAccountProblemCode;
  /** Не ошибка, но требует внимания: выбран не служебный ящик. Пишется в лог. */
  warning: string | null;
}

/** Заполнен ли адрес SMTP: «настроено» — ещё не «готово». */
export function smtpHostConfigured(account: SendAccountLike): boolean {
  return !!account.smtpHost;
}

/** Логин SMTP — по тому же правилу, что в smtpSender: отдельный, иначе логин ящика. */
export function smtpAuthUser(account: SendAccountLike): string {
  return account.smtpUsername || account.username;
}

/**
 * Готова ли отправка: адрес SMTP и любой из паролей (отдельный SMTP или пароль ящика).
 * Копировать сюда пароли не нужно: проверяется только их наличие в шифре.
 */
export function smtpReady(account: SendAccountLike): boolean {
  return smtpHostConfigured(account) && !!(account.smtpPasswordEncrypted || account.passwordEncrypted);
}

function notReadyProblem(account: SendAccountLike): string {
  if (!smtpHostConfigured(account)) {
    return (
      "У ящика " +
      account.username +
      " не настроена отправка (SMTP): не указан сервер исходящей почты. Настройте SMTP у этого ящика " +
      "или выберите другой служебный ящик в настройках."
    );
  }
  return (
    "У ящика " +
    account.username +
    " заполнен сервер SMTP, но нет пароля для отправки — письмо отправить нечем. " +
    "Укажите пароль SMTP (или пароль ящика) в настройках ящика."
  );
}

const NO_ACCOUNTS = "Не настроен ни один почтовый ящик — отправлять нечем. Добавьте ящик в настройках.";

/**
 * Текст отказа, когда служебный ящик не выбран (заморожен решением Lead'а).
 * Показывается аппарату интерфейсом, поэтому формулировка — часть контракта.
 */
const NOT_CHOSEN =
  "Служебный ящик не выбран: укажите его в настройках СЭД (Служебный ящик), иначе отправлять нечем.";

/**
 * Выбор ящика отправки официальных писем (Р12 + Р24, task-51).
 *
 * ⚠️ РЕШЕНИЕ Р24: в СЭД разрешены РОВНО ДВА ящика — служебный внутренний предприятия
 * и личный рабочий ЭТОГО работника. Ни «первый попавшийся», ни «первый готовый» ящик
 * больше не подставляются: это угадывание уже ловилось живым дефектом (письмо уходило
 * не от того адреса). Внешняя приёмная в список НЕ входит: с неё уходит только ответ
 * контрагенту по правилу композера (эта часть Р19 сохраняется).
 *
 * Приоритет: явно указанный (обязан быть в разрешённых) → личный рабочий → служебный
 * внутренний → понятная ошибка. Отказ всегда объясняется словами и машинным кодом.
 */
export function selectSendAccount(
  accounts: SendAccountLike[],
  opts: {
    explicitId?: string | null;
    /** Личный рабочий ящик работника («почта для СЭД», таблица user_settings). */
    personalId?: string | null;
    /** Служебный внутренний ящик предприятия (docflow.serviceAccountId). */
    configuredId?: string | null;
    /**
     * Выбор служебного ящика снят ЯВНО (строка настройки есть, значение пустое).
     * Отличается от «ещё не настраивали» только текстом отказа.
     */
    cleared?: boolean;
    /**
     * Белый список ящиков отправки в СЭД: служебный внутренний + личный рабочий работника.
     * Задан — явно переданный ящик вне списка отклоняется (account_not_allowed).
     * Не задан — проверка списка не применяется (служебные вызовы без правила Р24).
     */
    allowedIds?: string[] | null;
  } = {}
): SendAccountSelection {
  const list = Array.isArray(accounts) ? accounts : [];
  const explicitId = String(opts.explicitId ?? "").trim();
  const personalId = String(opts.personalId ?? "").trim();
  const configuredId = String(opts.configuredId ?? "").trim();
  const allowed = Array.isArray(opts.allowedIds)
    ? new Set(opts.allowedIds.map((id) => String(id ?? "").trim()).filter(Boolean))
    : null;
  const byId = (id: string): SendAccountLike | null => list.find((a) => a.id === id) ?? null;

  if (list.length === 0) {
    return { account: null, source: "none", problem: NO_ACCOUNTS, problemCode: "no_account", warning: null };
  }

  // 1) Явно указанный ящик: он ОБЯЗАН быть в разрешённых (Р24).
  if (explicitId) {
    if (allowed && !allowed.has(explicitId)) {
      return {
        account: null,
        source: "explicit",
        problem:
          "С этого ящика отправлять нельзя: в документообороте разрешены служебный ящик предприятия " +
          "и ваша личная рабочая почта (выбирается в настройках). Обновите список ящиков и повторите.",
        problemCode: "account_not_allowed",
        warning: null
      };
    }
    const explicit = byId(explicitId);
    // Явно указанный, но несуществующий ящик раньше МОЛЧА игнорировался и брался другой:
    // человек был уверен, что письмо ушло с выбранного ящика. Теперь это отказ.
    if (!explicit) {
      return {
        account: null,
        source: "explicit",
        problem: "Ящик для отправки не найден: " + explicitId + ". Обновите список ящиков и повторите.",
        problemCode: "unknown_account",
        warning: null
      };
    }
    if (!smtpReady(explicit)) {
      return {
        account: null,
        source: "explicit",
        problem: notReadyProblem(explicit),
        problemCode: "smtp_not_configured",
        warning: null
      };
    }
    return { account: explicit, source: "explicit", problem: null, problemCode: "ok", warning: null };
  }

  // 2) Личный рабочий ящик работника (Р24, решение Lead'а по T58).
  //    ⚠️ Выбранный работником ящик НЕ подменяем другим НИКОГДА: ни когда у него не настроена
  //    отправка, ни когда его удалили. Иначе официальное письмо уйдёт не от того адреса,
  //    который человек выбрал, — ровно та молчаливая подмена, за которую мы уже платили.
  if (personalId) {
    const personal = byId(personalId);
    if (personal && smtpReady(personal)) {
      return { account: personal, source: "personal", problem: null, problemCode: "ok", warning: null };
    }
    if (personal) {
      // Починить может либо работник (выбрать другой ящик), либо администратор (настроить SMTP).
      return {
        account: personal,
        source: "personal",
        problem: notReadyProblem(personal),
        problemCode: "smtp_not_configured",
        warning: null
      };
    }
    // Ящик выбран, но его больше нет в почте: честно говорим об этом, а не уходим на служебный.
    return {
      account: null,
      source: "personal",
      problem:
        "Выбранный ящик для СЭД больше не существует (его удалили из почты) — выберите другой " +
        "в настройках «Почта для СЭД».",
      problemCode: "account_missing",
      warning: null
    };
  }

  // 3) Служебный внутренний ящик предприятия.
  if (configuredId) {
    const service = byId(configuredId);
    if (service && smtpReady(service)) {
      return { account: service, source: "service", problem: null, problemCode: "ok", warning: null };
    }
    if (service) {
      // Служебный выбран осознанно — чужим ящиком не подменяем: получатель увидел бы другого
      // отправителя, а «от чьего имени ушло» — вопрос доверия.
      return {
        account: service,
        source: "service",
        problem: notReadyProblem(service),
        problemCode: "smtp_not_configured",
        warning: null
      };
    }
    // Настроенный ящик удалён: «первый готовый» подставлять запрещено (Р24).
    return {
      account: null,
      source: "none",
      problem: "Служебный ящик из настроек (" + configuredId + ") больше не существует — задайте его заново.",
      problemCode: "account_missing",
      warning: null
    };
  }

  // 4) Ничего не выбрано (или служебный снят явно).
  if (opts.cleared) {
    return { account: null, source: "none", problem: NOT_CHOSEN, problemCode: "not_configured", warning: null };
  }
  return {
    account: null,
    source: "none",
    problem:
      "Ящик для отправки не выбран: укажите служебный ящик предприятия в настройках СЭД или выберите " +
      "личную рабочую почту для документооборота. Подставлять «первый попавшийся» ящик запрещено.",
    problemCode: "not_configured",
    warning: null
  };
}

/** Параметры ящика для подсказки аппарату: хост, порт, tls, логин. ПАРОЛЬ НЕ ОТДАЁТСЯ. */
export interface ServiceAccountViewAccount {
  accountId: string;
  name: string;
  username: string;
  protocol: string;
  host: string;
  port: number;
  tls: string;
  authType: string;
  /** Логин для отправки (SMTP): отдельный, иначе логин ящика. */
  smtpUsername: string;
  smtpHost: string;
  smtpPort: number | null;
  smtpTls: string | null;
  /** Заполнен ли адрес SMTP (поле непустое). */
  smtpHostConfigured: boolean;
  /** Отправка РЕАЛЬНО возможна: адрес SMTP и есть чем авторизоваться (правило sendService). */
  smtpConfigured: boolean;
}

export interface ServiceAccountView {
  /** Служебный ящик выбран И найден среди ящиков. */
  configured: boolean;
  account: ServiceAccountViewAccount | null;
  /** Плоский текст для человека. Разметку сервер не кладёт — UI рендерит текстом. */
  problem: string | null;
  /** ok | not_configured | account_missing | smtp_not_configured (UI не парсит текст). */
  problemCode: SendAccountProblemCode;
}

const NOT_CONFIGURED =
  "Служебный ящик ещё не задан: укажите его в настройках, чтобы аппарат знал, к какому ящику подключаться.";

/**
 * Собирает ответ ДЛЯ АППАРАТА из записи ящика.
 *
 * ⚠️ Поля выбираются ПОИМЁННО: у записи есть passwordEncrypted и smtpPasswordEncrypted,
 * и spreading её целиком выдал бы секреты наружу. Пароль вообще не покидает сервер (Р12).
 */
export function serviceAccountView(
  account: SendAccountLike | null,
  opts: {
    configuredId?: string | null;
    /**
     * Нужна ли этой роли возможность ОТПРАВКИ. Внутренняя делопроизводства отправляет —
     * ей SMTP обязателен. Внешняя приёмная только принимает почту (IMAP/POP3), и отсутствие
     * SMTP у неё — не проблема, а справка: иначе администратор видит «ошибку» там, где всё
     * работает (нашлось при живом прогоне T25: ящик директора без SMTP годится как приёмный).
     */
    requiresSmtp?: boolean;
  } = {}
): ServiceAccountView {
  const requiresSmtp = opts.requiresSmtp !== false;
  const configuredId = String(opts.configuredId ?? "").trim();
  if (!account) {
    // «Задан, но не найден» — не то же самое, что «не задан»: у первого есть мёртвая ссылка,
    // и UI по problemCode покажет «выберите другой ящик», а не «настройте ящик».
    if (configuredId) {
      return {
        // configured = «в настройках что-то выбрано», поэтому true: выбор есть, а ящика нет.
        configured: true,
        account: null,
        problem:
          "Выбранный служебный ящик больше не существует (id " +
          configuredId +
          ") — выберите другой в настройках.",
        problemCode: "account_missing"
      };
    }
    return { configured: false, account: null, problem: NOT_CONFIGURED, problemCode: "not_configured" };
  }
  // Факт про ящик (нужен ли он роли — отдельный вопрос) и решение по роли.
  const smtpOk = smtpReady(account);
  const problemFree = requiresSmtp ? smtpOk : true;
  return {
    configured: true,
    account: {
      accountId: account.id,
      name: account.username,
      username: account.username,
      protocol: account.protocol,
      host: account.host,
      port: account.port,
      tls: account.tls,
      authType: account.authType ?? "",
      smtpUsername: smtpAuthUser(account),
      smtpHost: account.smtpHost ?? "",
      smtpPort: account.smtpPort ?? null,
      smtpTls: account.smtpTls ?? null,
      smtpHostConfigured: smtpHostConfigured(account),
      // Справка о ящике: «отправлять с него можно/нельзя». Для приёмной роли это не ошибка.
      smtpConfigured: smtpOk
    },
    problem: problemFree ? null : notReadyProblem(account),
    problemCode: problemFree ? "ok" : "smtp_not_configured"
  };
}
