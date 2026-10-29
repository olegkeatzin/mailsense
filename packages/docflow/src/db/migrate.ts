import type { Pool } from "pg";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Миграции серверной части для PostgreSQL. Собственная нумерация с 1:
 * это отдельная база со своим жизненным циклом, а не продолжение
 * цепочки локального почтового клиента (тот живёт на SQLite).
 */
export const docflowMigrations: Migration[] = [
  {
    version: 1,
    name: "users_roles_sessions_audit",
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  ldap_uid TEXT,
  ldap_uid_key TEXT,
  ldap_dn TEXT,
  email TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  manager_dn TEXT,
  manager_id TEXT,
  phone TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ldap',
  password_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- NULL в PostgreSQL уникальны по умолчанию: локальные учётки без логина не конфликтуют.
-- Ключ поиска хранится отдельно, потому что lower() зависит от локали, а логины AD кириллические.
CREATE UNIQUE INDEX IF NOT EXISTS users_ldap_uid_key_idx ON users(ldap_uid_key);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_active_idx ON users(is_active);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles(role_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO roles (id, name, description, sort_order, is_system) VALUES
  ('admin', 'Администратор', 'Полный доступ, управление пользователями и настройками', 10, TRUE),
  ('secretary', 'Секретарь / Аппарат', 'Ведение журнала, регистрация и архивация документов', 20, TRUE),
  ('manager', 'Руководитель', 'Наложение резолюций и контроль исполнения', 30, TRUE),
  ('executor', 'Исполнитель', 'Получение задач и отчёт об исполнении', 40, TRUE)
ON CONFLICT (id) DO NOTHING;
`
  },
  {
    version: 2,
    name: "journal_documents_numbering",
    sql: `-- Журнал входящих документов. Колонки повторяют бумажный журнал (10 графов).
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  -- Графа 1: входящий номер по порядку. Уникален ВНУТРИ периода (года).
  reg_number TEXT NOT NULL,
  -- Числовая часть номера: нужна для сортировки «вх2» < «вх10».
  reg_number_numeric INTEGER NOT NULL DEFAULT 0,
  reg_period TEXT NOT NULL,
  -- Графа 2: дата регистрации (автоматически).
  reg_date TEXT NOT NULL,
  -- Графа 3: номер и дата документа из письма (заполняет ИИ, правится вручную).
  doc_number TEXT NOT NULL DEFAULT '',
  doc_date TEXT,
  -- Графа 4: от кого получен.
  sender TEXT NOT NULL DEFAULT '',
  -- Графа 5: краткое содержание.
  summary TEXT NOT NULL DEFAULT '',
  -- Графа 6: количество листов.
  sheets_count INTEGER,
  -- Графа 10: номер дела, куда подшит документ.
  case_number TEXT,
  document_name TEXT NOT NULL DEFAULT '',
  -- new | on_resolution | in_progress | executed | archived
  status TEXT NOT NULL DEFAULT 'new',
  -- Основное письмо (в базе клиента; внешнего ключа нет — разные базы).
  email_id TEXT,
  correspondent_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
-- Два документа с одним номером в одном году невозможны на уровне БД:
-- это последняя линия защиты, если приложение когда-нибудь ошибётся.
CREATE UNIQUE INDEX IF NOT EXISTS documents_period_number_idx ON documents(reg_period, reg_number);
CREATE INDEX IF NOT EXISTS documents_reg_date_idx ON documents(reg_date);
CREATE INDEX IF NOT EXISTS documents_email_idx ON documents(email_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);
CREATE INDEX IF NOT EXISTS documents_case_idx ON documents(case_number);
CREATE INDEX IF NOT EXISTS documents_doc_number_idx ON documents(doc_number);

-- Связь документа с письмами: входящее, резолюция, отчёт об исполнении.
CREATE TABLE IF NOT EXISTS document_emails (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  email_id TEXT NOT NULL,
  -- source | resolution | report | other
  role TEXT NOT NULL DEFAULT 'source',
  linked_at TEXT NOT NULL,
  linked_by TEXT,
  PRIMARY KEY (document_id, email_id)
);
CREATE INDEX IF NOT EXISTS document_emails_email_idx ON document_emails(email_id);
-- Одно и то же письмо не может быть источником двух документов: защита
-- от повторной регистрации одного входящего.
CREATE UNIQUE INDEX IF NOT EXISTS document_emails_source_idx ON document_emails(email_id) WHERE role = 'source';

-- Счётчики номеров по потокам и периодам. Инкремент атомарный (см. numbering).
CREATE TABLE IF NOT EXISTS number_counters (
  stream TEXT NOT NULL,
  period TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stream, period)
);

CREATE TABLE IF NOT EXISTS number_rules (
  stream TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  reset TEXT NOT NULL DEFAULT 'year',
  template TEXT
);

-- Выгрузки журнала в архив. Пока год не выгружен, новый год не открывается.
CREATE TABLE IF NOT EXISTS number_archives (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  period TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  document_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS number_archives_period_idx ON number_archives(stream, period);

-- Номенклатура дел (графа 10).
CREATE TABLE IF NOT EXISTS case_nomenclature (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS case_nomenclature_code_idx ON case_nomenclature(code);

CREATE TABLE IF NOT EXISTS correspondents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  inn TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS correspondents_name_idx ON correspondents(name);

-- Типовые сроки исполнения и шаблоны резолюций (пригодятся на этапе 3).
CREATE TABLE IF NOT EXISTS deadline_presets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resolution_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Правила нумерации по умолчанию: «вх1», «исх1», сброс каждый год.
INSERT INTO number_rules (stream, prefix, reset, template) VALUES
  ('incoming', 'вх', 'year', NULL),
  ('outgoing', 'исх', 'year', NULL)
ON CONFLICT (stream) DO NOTHING;`
  },
  {
    version: 3,
    name: "resolutions_approval_assignees",
    sql: `-- Резолюции: один документ → много резолюций, у резолюции → много исполнителей (Р5).
CREATE TABLE IF NOT EXISTS resolutions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Текст, который уходит исполнителям (после правок аппарата и подписанта).
  text TEXT NOT NULL DEFAULT '',
  -- Исходный текст ДО правок: что предложил ИИ и что написал подписант.
  -- Нужен для будущей подсказки резолюции: учиться надо на живых формулировках,
  -- а не на причёсанном итоге (см. Часть 7 журнала решений).
  source_text TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'manual',
  -- draft | pending_approval | approved | sent | done | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  -- urgent | important | normal
  priority TEXT NOT NULL DEFAULT 'normal',
  deadline TEXT,
  -- Авторы. Разделены намеренно: «кто придумал», «кто подписал», «кто отправил» —
  -- это разные люди, и при разборе ошибки важно знать, на каком шаге она возникла.
  prepared_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  -- app | email — способ утверждения (Р9)
  approval_method TEXT,
  -- Способ В: аппарат подтвердил, что подписант действительно утвердил.
  confirmed_by TEXT,
  confirmed_at TEXT,
  -- Отправляет всегда аппарат (Р9).
  dispatched_by TEXT,
  dispatched_at TEXT,
  request_email_id TEXT,
  approval_email_id TEXT,
  dispatch_email_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resolutions_document_idx ON resolutions(document_id);
CREATE INDEX IF NOT EXISTS resolutions_status_idx ON resolutions(status);
CREATE INDEX IF NOT EXISTS resolutions_deadline_idx ON resolutions(deadline);

-- Исполнители резолюции. Графа 8 журнала «Кому передано на исполнение (расписка)».
CREATE TABLE IF NOT EXISTS resolution_assignees (
  resolution_id TEXT NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- responsible | coexecutor (Р10): поддержаны оба порядка работы.
  kind TEXT NOT NULL DEFAULT 'coexecutor',
  -- «Расписка»: исполнитель подтвердил, что получил документ (О6).
  received_at TEXT,
  -- Отчёт об исполнении (этап 4).
  report_text TEXT,
  report_at TEXT,
  report_email_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resolution_id, user_id)
);
CREATE INDEX IF NOT EXISTS resolution_assignees_user_idx ON resolution_assignees(user_id);
-- Ответственный в резолюции может быть только один: это гарантия уровня БД,
-- иначе «с кого спрос» станет неопределённым.
CREATE UNIQUE INDEX IF NOT EXISTS resolution_one_responsible_idx
  ON resolution_assignees(resolution_id) WHERE kind = 'responsible';

-- История утверждения: видно каждый шаг и кто его сделал.
CREATE TABLE IF NOT EXISTS resolution_approvals (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  -- requested | approved | rejected | confirmed | dispatched
  step TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  -- app | email | manual
  method TEXT,
  comment TEXT,
  email_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resolution_approvals_res_idx ON resolution_approvals(resolution_id);`
  },
  {
    version: 4,
    name: "signer_role",
    sql: `-- Роль «Подписант»: ген.дир или тот, кому он делегировал право подписи (Р9).
-- Отдельная роль, а не выдача через «Руководителя»: подписывать может и начальник аппарата,
-- которому права руководителя не нужны.
INSERT INTO roles (id, name, description, sort_order, is_system) VALUES
  ('signer', 'Подписант', 'Утверждение резолюций (ген.дир или тот, кому он делегировал право подписи)', 50, TRUE)
ON CONFLICT (id) DO NOTHING;`
  },
  {
    version: 5,
    name: "report_proposals",
    sql: `-- Предложение отчёта, распознанное моделью в ответе исполнителя.
--
-- Отчёт НЕ применяется автоматически: ложное закрытие поручения хуже пропущенного отчёта.
-- Модель заполняет предложение, аппарат проверяет и подтверждает — тогда report_at
-- проставляется и срабатывает правило закрытия (Р10).
--
-- ⚠️ IF NOT EXISTS обязателен: колонки могли появиться раньше самой миграции (руками
-- или прерванным прогоном), и тогда обычный ADD COLUMN падал бы и останавливал старт.
ALTER TABLE resolution_assignees ADD COLUMN IF NOT EXISTS report_summary TEXT;
ALTER TABLE resolution_assignees ADD COLUMN IF NOT EXISTS report_proposed_at TEXT;`
  },
  {
    // Номер сверен с docflow_migrations ЖИВОЙ базы (mailsense): там 1..5, значит свободен 6.
    version: 6,
    name: "unique_user_email",
    sql: `-- Один и тот же адрес не может принадлежать двум учётным записям: дубль в
-- справочнике означает, что письмо и поручение уходят не тому человеку.
--
-- Индекс ЧАСТИЧНЫЙ: пустой адрес — законное состояние (аварийная локальная учётка
-- без адреса в каталоге), и таких записей может быть сколько угодно.
-- Сравнение по lower(email): приложение ищет адрес без учёта регистра
-- (getUserByEmail), поэтому «Ivanov@x.ru» и «ivanov@x.ru» — один человек.
--
-- Если дубли уже есть, миграция обязана объяснить это словами: молча удалять
-- учётки нельзя, а «could not create unique index» ничего не говорит администратору.
DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(e || ' x' || n, ', ') INTO dup FROM (
    SELECT lower(email) AS e, count(*) AS n FROM users
    WHERE email <> '' GROUP BY lower(email) HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Нельзя включить уникальность email: дубли в справочнике — %', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq_idx ON users (lower(email)) WHERE email <> '';`
  },
  {
    // Номер сверен с docflow_migrations ЖИВОЙ базы (mailsense) и тестовой 2026-10-07: там 1..6,
    // значит свободен 7. Занятый номер молча пропускается — это уже стоило времени.
    version: 7,
    name: "notifications_templates_and_sort_rules",
    sql: `-- Уведомления (этап 5): только ВНУТРИ приложения. Писем-напоминаний не отправляем (Р11).
-- dedupe_key уникален в пределах пользователя: на этом держится идемпотентность
-- материализации сроков — каждое чтение досчитывает недостающие напоминания,
-- но повторно их не создаёт (второе чтение не должно плодить дубли).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications(user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

-- Шаблоны текста уведомлений: key = kind. Правятся администратором в настройках.
CREATE TABLE IF NOT EXISTS notification_templates (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Правила автосортировки: маршрутизация и подсветка, НЕ авторегистрация.
-- Документ по-прежнему создаёт человек: правило не выдаёт номер и не пишет в журнал.
CREATE TABLE IF NOT EXISTS mail_sort_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  match_from TEXT NOT NULL DEFAULT '',
  match_to TEXT NOT NULL DEFAULT '',
  match_subject TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  priority INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Приложение А9: типовые сроки. Колонка добавляется IF NOT EXISTS — таблица заведена
-- ещё миграцией v2, и на живой базе колонки может не быть; обычный ADD COLUMN упал бы
-- и остановил старт сервера.
ALTER TABLE deadline_presets ADD COLUMN IF NOT EXISTS is_workday BOOLEAN NOT NULL DEFAULT TRUE;
INSERT INTO deadline_presets (id, title, days, is_active, sort_order, is_workday) VALUES
  ('wd-3', '3 рабочих дня', 3, TRUE, 10, TRUE),
  ('wd-10', '10 рабочих дней', 10, TRUE, 20, TRUE),
  ('cal-30', '30 календарных дней', 30, TRUE, 30, FALSE)
ON CONFLICT (id) DO NOTHING;

-- Дефолтные шаблоны для всех kind из §3. Дефолтных ПРАВИЛ сортировки не сеем:
-- пустой список честнее выдуманного правила, которое пометит чужую почту.
-- ON CONFLICT (key) DO NOTHING — цель указана явно: без цели гасится любой уникальный
-- индекс, и повторный прогон выглядел бы успешным, ничего не сделав.
INSERT INTO notification_templates (key, title, body) VALUES
  ('resolution.assigned', 'Новое поручение {regNumber}', 'Вам поручено: {text}. Срок: {deadline}.'),
  ('resolution.approved', 'Резолюция утверждена {regNumber}', 'Утверждено поручение: {text}. Пора отправлять исполнителям.'),
  ('resolution.reported', 'Отчёт по поручению {regNumber}', '{author} отчитался: {text}'),
  ('resolution.closed', 'Поручение исполнено {regNumber}', 'Поручение закрыто: {text}'),
  ('resolution.due_soon', 'Срок через {daysLeft} дн. — {regNumber}', 'Поручение: {text}. Срок {deadline}.'),
  ('resolution.due_today', 'Срок сегодня — {regNumber}', 'Поручение: {text}. Срок {deadline}.'),
  ('resolution.overdue', 'Просрочено: {regNumber}', 'Поручение: {text}. Срок был {deadline}.'),
  ('resolution.overdue_escalation', 'Просрочено у исполнителя: {regNumber}', 'Поручение: {text}. Срок был {deadline}.')
ON CONFLICT (key) DO NOTHING;`
  },
  {
    // Номер сверен с docflow_migrations ЖИВОЙ (mailsense) и ТЕСТОВОЙ (mailsense_test) баз:
    // в обеих 1..7, значит свободен 8.
    version: 8,
    name: "user_activity_stats",
    sql: `-- Производная агрегация «профиль исполнителя» (task-18): данные под БУДУЩУЮ подсказку
-- исполнителей. Сама подсказка не реализована (граф знаний — после 0.1.4).
--
-- Это ПРОИЗВОДНЫЕ данные: сырые таблицы (documents, resolutions, resolution_assignees,
-- users) только читаются, результат складывается сюда. Одна строка на пользователя,
-- чтобы пересчёт был идемпотентным: строка заменяется целиком в одной транзакции,
-- а raw_fingerprint позволяет вообще не переписывать её, если сырьё не изменилось.
CREATE TABLE IF NOT EXISTS user_activity_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  documents_registered INTEGER NOT NULL DEFAULT 0,
  tasks_assigned INTEGER NOT NULL DEFAULT 0,
  tasks_reported INTEGER NOT NULL DEFAULT 0,
  tasks_open INTEGER NOT NULL DEFAULT 0,
  tasks_overdue INTEGER NOT NULL DEFAULT 0,
  resolutions_prepared INTEGER NOT NULL DEFAULT 0,
  resolutions_approved INTEGER NOT NULL DEFAULT 0,
  resolutions_dispatched INTEGER NOT NULL DEFAULT 0,
  avg_execution_days DOUBLE PRECISION,
  -- Топы: только счётчики и названия/имена/теги, без текстов писем и адресов (приватность).
  correspondence_orgs JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_departments JSONB NOT NULL DEFAULT '[]'::jsonb,
  authors JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_fingerprint TEXT NOT NULL DEFAULT '',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Месячная разбивка: «какие письма человек получает по месяцам» — то, из чего потом
-- собирается краткое описание профиля для графа знаний.
CREATE TABLE IF NOT EXISTS user_activity_stats_monthly (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  documents_registered INTEGER NOT NULL DEFAULT 0,
  tasks_assigned INTEGER NOT NULL DEFAULT 0,
  tasks_reported INTEGER NOT NULL DEFAULT 0,
  correspondence_orgs JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);
CREATE INDEX IF NOT EXISTS user_activity_stats_monthly_period_idx ON user_activity_stats_monthly(period);`
  },
  {
    // Номер сверен с docflow_migrations ЖИВОЙ (mailsense) и ТЕСТОВОЙ (mailsense_test) баз:
    // в обеих 1..8, значит свободен 9.
    version: 9,
    name: "user_settings",
    sql: `-- Личные настройки работника в СЭД (Р24, task-51). Первый и пока единственный ключ —
-- «почта для СЭД» (edms.workAccountId): работник выбирает, с какого ящика уходят
-- официальные письма по его поручениям.
--
-- Настройка личная, но живёт на СЕРВЕРЕ (в отличие от mail_profile в клиенте):
-- от неё зависит выбор ящика отправки, а это решение предприятия.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);`
  },
  {
    // ⚠️ Номер 10 — следующий свободный после 9.
    version: 10,
    name: "role_permissions",
    sql: `
-- Права роли переезжают в базу: администратор создаёт роли и расставляет галочки сам
-- (конструктор ролей). NULL = «ещё не засеяно»: встроенные права подставит docflow при старте.
-- Пустой массив '[]' — осознанное «прав нет» и повторно не засеивается.
-- ⚠️ IF NOT EXISTS обязателен: тест идемпотентности прогоняет миграции повторно на уже
-- мигрированной базе, и без этого падало «column already exists» — а следом рушились
-- все тесты, которые ходят в ту же базу.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS permissions TEXT;
`
  },
  {
    // ⚠️ Номер 11 — следующий свободный после 10.
    version: 11,
    name: "document_files_path",
    sql: `-- Папка вложений зарегистрированного документа на сервере (mailDocs/<вх><год>_<дата>).
-- NULL = папка ещё не создана; сервер заполнит её при открытии карточки/скачивании.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_files_path TEXT;`
  },
  {
    // В уведомлении о закрытии должно быть видно, кто закрыл поручение:
    // иначе руководитель и исполнитель не знают, чьё это решение.
    version: 12,
    name: "notification_closed_author",
    sql: `UPDATE notification_templates
SET body = 'Поручение закрыто: {text}. Закрыл: {author}'
WHERE key = 'resolution.closed';`
  }
];

/** Применяет недостающие миграции. Каждая идёт в своей транзакции. */
export async function runDocflowMigrations(pool: Pool): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS docflow_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  );
  const { rows } = await pool.query<{ version: number }>("SELECT version FROM docflow_migrations");
  const applied = new Set(rows.map((r) => r.version));

  for (const m of docflowMigrations.filter((x) => !applied.has(x.version))) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query("INSERT INTO docflow_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [
        m.version,
        m.name,
        new Date().toISOString()
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
