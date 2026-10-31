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
  },
  {
    // correspondent_id был просто текстовым полем без связи со справочником.
    // Заполняем его по отправителю и добавляем настоящий внешний ключ.
    version: 13,
    name: "documents_correspondent_fk",
    sql: `
INSERT INTO correspondents (id, name, short_name, inn, is_active, created_at, updated_at)
SELECT gen_random_uuid(), d.sender, '', '', TRUE, now(), now()
FROM documents d
WHERE d.correspondent_id IS NULL
  AND btrim(d.sender) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM correspondents c WHERE lower(c.name) = lower(d.sender)
  )
GROUP BY d.sender;

UPDATE documents d
SET correspondent_id = c.id
FROM correspondents c
WHERE d.correspondent_id IS NULL
  AND btrim(d.sender) <> ''
  AND lower(c.name) = lower(d.sender);

-- Старые «висячие» ссылки не должны помешать включить внешний ключ.
UPDATE documents d
SET correspondent_id = NULL
WHERE d.correspondent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.id = d.correspondent_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_correspondent_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_correspondent_id_fkey
      FOREIGN KEY (correspondent_id) REFERENCES correspondents(id) ON DELETE SET NULL;
  END IF;
END $$;
`
  },
  {
    // Комментарии к таблицам и полям: их видно в ERD/клиенте БД без чтения кода.
    version: 14,
    name: "column_comments",
    sql: `
COMMENT ON TABLE users IS 'Пользователи СЭД: синхронизированные из AD и локальные учётные записи.';
COMMENT ON COLUMN users.id IS 'Идентификатор пользователя (внутренний UUID).';
COMMENT ON COLUMN users.ldap_uid IS 'sAMAccountName/логин из каталога AD.';
COMMENT ON COLUMN users.ldap_uid_key IS 'Нормализованный ключ логина AD для поиска без учёта регистра.';
COMMENT ON COLUMN users.ldap_dn IS 'Полный DN пользователя в каталоге AD.';
COMMENT ON COLUMN users.email IS 'Адрес электронной почты работника.';
COMMENT ON COLUMN users.full_name IS 'ФИО работника.';
COMMENT ON COLUMN users.department IS 'Подразделение из каталога.';
COMMENT ON COLUMN users.position IS 'Должность из каталога.';
COMMENT ON COLUMN users.manager_dn IS 'DN руководителя в каталоге AD.';
COMMENT ON COLUMN users.manager_id IS 'Идентификатор руководителя в этой таблице.';
COMMENT ON COLUMN users.phone IS 'Телефон работника.';
COMMENT ON COLUMN users.source IS 'Источник записи: ldap, local или manual.';
COMMENT ON COLUMN users.password_hash IS 'Хэш пароля локальной учётной записи; для AD пуст.';
COMMENT ON COLUMN users.is_active IS 'Активность по данным каталога.';
COMMENT ON COLUMN users.blocked IS 'Ручная блокировка администратором.';
COMMENT ON COLUMN users.last_login_at IS 'Время последнего успешного входа.';
COMMENT ON COLUMN users.created_at IS 'Когда запись создана.';
COMMENT ON COLUMN users.updated_at IS 'Когда запись последний раз изменена.';

COMMENT ON TABLE roles IS 'Роли СЭД и их права.';
COMMENT ON COLUMN roles.id IS 'Идентификатор роли.';
COMMENT ON COLUMN roles.name IS 'Название роли.';
COMMENT ON COLUMN roles.description IS 'Описание роли.';
COMMENT ON COLUMN roles.sort_order IS 'Порядок роли в интерфейсе.';
COMMENT ON COLUMN roles.is_system IS 'Встроенная роль, которую нельзя удалить.';
COMMENT ON COLUMN roles.permissions IS 'JSON-массив прав роли; NULL — права ещё не засеяны.';

COMMENT ON TABLE user_roles IS 'Связь пользователей и ролей.';
COMMENT ON COLUMN user_roles.user_id IS 'Пользователь.';
COMMENT ON COLUMN user_roles.role_id IS 'Роль.';
COMMENT ON COLUMN user_roles.granted_at IS 'Когда роль выдана.';
COMMENT ON COLUMN user_roles.granted_by IS 'Кто выдал роль.';

COMMENT ON TABLE sessions IS 'Серверные сессии входа в СЭД.';
COMMENT ON COLUMN sessions.id IS 'SHA-256 токена сессии; сам токен не хранится.';
COMMENT ON COLUMN sessions.user_id IS 'Пользователь сессии.';
COMMENT ON COLUMN sessions.created_at IS 'Когда сессия создана.';
COMMENT ON COLUMN sessions.expires_at IS 'Когда сессия истекает.';
COMMENT ON COLUMN sessions.last_seen_at IS 'Последняя активность сессии.';
COMMENT ON COLUMN sessions.user_agent IS 'User-Agent клиента.';
COMMENT ON COLUMN sessions.ip IS 'IP-адрес клиента.';

COMMENT ON TABLE audit_log IS 'Неизменяемый журнал действий: кто, когда и что изменил.';
COMMENT ON COLUMN audit_log.id IS 'Идентификатор записи аудита.';
COMMENT ON COLUMN audit_log.user_id IS 'Идентификатор автора; без FK, чтобы история переживала удаление пользователя.';
COMMENT ON COLUMN audit_log.user_name IS 'ФИО автора на момент события.';
COMMENT ON COLUMN audit_log.action IS 'Код действия, например journal.register.';
COMMENT ON COLUMN audit_log.entity_type IS 'Тип изменённого объекта.';
COMMENT ON COLUMN audit_log.entity_id IS 'Идентификатор изменённого объекта.';
COMMENT ON COLUMN audit_log.old_value IS 'Состояние до изменения в JSON.';
COMMENT ON COLUMN audit_log.new_value IS 'Состояние после изменения в JSON.';
COMMENT ON COLUMN audit_log.created_at IS 'Время события.';

COMMENT ON TABLE settings IS 'Общие настройки серверной части СЭД.';
COMMENT ON COLUMN settings.key IS 'Имя настройки.';
COMMENT ON COLUMN settings.value IS 'Значение настройки в строковом виде.';

COMMENT ON TABLE user_settings IS 'Личные настройки работника в СЭД.';
COMMENT ON COLUMN user_settings.user_id IS 'Пользователь.';
COMMENT ON COLUMN user_settings.key IS 'Имя личной настройки, например edms.workAccountId.';
COMMENT ON COLUMN user_settings.value IS 'Значение настройки.';
COMMENT ON COLUMN user_settings.updated_at IS 'Когда настройка изменена.';

COMMENT ON TABLE documents IS 'Журнал входящих документов.';
COMMENT ON COLUMN documents.id IS 'Идентификатор документа.';
COMMENT ON COLUMN documents.reg_number IS 'Регистрационный номер вида вх1.';
COMMENT ON COLUMN documents.reg_number_numeric IS 'Числовая часть номера для правильной сортировки.';
COMMENT ON COLUMN documents.reg_period IS 'Период нумерации, обычно год.';
COMMENT ON COLUMN documents.reg_date IS 'Дата регистрации.';
COMMENT ON COLUMN documents.doc_number IS 'Номер документа отправителя.';
COMMENT ON COLUMN documents.doc_date IS 'Дата документа отправителя.';
COMMENT ON COLUMN documents.sender IS 'Отправитель, как указан в документе.';
COMMENT ON COLUMN documents.summary IS 'Краткое содержание документа.';
COMMENT ON COLUMN documents.sheets_count IS 'Количество листов.';
COMMENT ON COLUMN documents.case_number IS 'Номер дела.';
COMMENT ON COLUMN documents.document_name IS 'Наименование документа.';
COMMENT ON COLUMN documents.status IS 'Состояние документа: new, on_resolution, in_progress, executed, archived.';
COMMENT ON COLUMN documents.email_id IS 'ID исходного письма в почтовой SQLite; FK между базами нет.';
COMMENT ON COLUMN documents.doc_files_path IS 'Папка вложений дела на сервере; NULL — ещё не создана.';
COMMENT ON COLUMN documents.correspondent_id IS 'Ссылка на correspondents.id; NULL — отправитель не сопоставлен.';
COMMENT ON COLUMN documents.created_by IS 'Кто зарегистрировал документ.';
COMMENT ON COLUMN documents.created_at IS 'Когда документ создан.';
COMMENT ON COLUMN documents.updated_at IS 'Когда документ последний раз изменён.';
COMMENT ON COLUMN documents.archived_at IS 'Когда документ выгружен в архив.';

COMMENT ON TABLE document_emails IS 'Связь документа с письмами: входящее, резолюция, отчёт.';
COMMENT ON COLUMN document_emails.document_id IS 'Документ.';
COMMENT ON COLUMN document_emails.email_id IS 'ID письма в почтовой SQLite; FK между базами нет.';
COMMENT ON COLUMN document_emails.role IS 'Роль письма в деле: source, resolution, report и т.п.';
COMMENT ON COLUMN document_emails.linked_at IS 'Когда письмо привязано.';
COMMENT ON COLUMN document_emails.linked_by IS 'Кто привязал письмо.';

COMMENT ON TABLE number_counters IS 'Счётчики номеров по потоку и периоду.';
COMMENT ON COLUMN number_counters.stream IS 'Поток нумерации, например incoming.';
COMMENT ON COLUMN number_counters.period IS 'Период нумерации.';
COMMENT ON COLUMN number_counters.last_number IS 'Последний выданный номер.';

COMMENT ON TABLE number_rules IS 'Правила нумерации по потокам.';
COMMENT ON COLUMN number_rules.stream IS 'Поток нумерации.';
COMMENT ON COLUMN number_rules.prefix IS 'Префикс номера.';
COMMENT ON COLUMN number_rules.reset IS 'Периодичность сброса счётчика.';
COMMENT ON COLUMN number_rules.template IS 'Необязательный шаблон номера.';

COMMENT ON TABLE number_archives IS 'Выгруженные и закрытые периоды журнала.';
COMMENT ON COLUMN number_archives.id IS 'Идентификатор архива.';
COMMENT ON COLUMN number_archives.stream IS 'Поток нумерации.';
COMMENT ON COLUMN number_archives.period IS 'Закрытый период.';
COMMENT ON COLUMN number_archives.file_name IS 'Имя файла выгрузки.';
COMMENT ON COLUMN number_archives.document_count IS 'Сколько документов в архиве.';
COMMENT ON COLUMN number_archives.created_at IS 'Когда архив создан.';
COMMENT ON COLUMN number_archives.created_by IS 'Кто закрыл период.';

COMMENT ON TABLE case_nomenclature IS 'Номенклатура дел.';
COMMENT ON COLUMN case_nomenclature.id IS 'Идентификатор дела.';
COMMENT ON COLUMN case_nomenclature.code IS 'Код дела.';
COMMENT ON COLUMN case_nomenclature.title IS 'Название дела.';
COMMENT ON COLUMN case_nomenclature.is_active IS 'Можно ли выбирать дело.';
COMMENT ON COLUMN case_nomenclature.sort_order IS 'Порядок в списке.';
COMMENT ON COLUMN case_nomenclature.created_at IS 'Когда дело создано.';
COMMENT ON COLUMN case_nomenclature.updated_at IS 'Когда дело изменено.';

COMMENT ON TABLE correspondents IS 'Справочник корреспондентов: организации и лица, от которых получены документы.';
COMMENT ON COLUMN correspondents.id IS 'Идентификатор корреспондента.';
COMMENT ON COLUMN correspondents.name IS 'Полное название корреспондента.';
COMMENT ON COLUMN correspondents.short_name IS 'Краткое название.';
COMMENT ON COLUMN correspondents.inn IS 'ИНН корреспондента.';
COMMENT ON COLUMN correspondents.is_active IS 'Можно ли выбирать корреспондента.';
COMMENT ON COLUMN correspondents.created_at IS 'Когда корреспондент создан.';
COMMENT ON COLUMN correspondents.updated_at IS 'Когда корреспондент изменён.';

COMMENT ON TABLE deadline_presets IS 'Типовые сроки исполнения.';
COMMENT ON COLUMN deadline_presets.id IS 'Идентификатор срока.';
COMMENT ON COLUMN deadline_presets.title IS 'Название срока.';
COMMENT ON COLUMN deadline_presets.days IS 'Количество дней.';
COMMENT ON COLUMN deadline_presets.is_active IS 'Показывать ли срок в форме.';
COMMENT ON COLUMN deadline_presets.sort_order IS 'Порядок в списке.';
COMMENT ON COLUMN deadline_presets.is_workday IS 'Считать ли дни рабочими.';

COMMENT ON TABLE resolution_templates IS 'Шаблоны текста резолюций.';
COMMENT ON COLUMN resolution_templates.id IS 'Идентификатор шаблона.';
COMMENT ON COLUMN resolution_templates.title IS 'Название шаблона.';
COMMENT ON COLUMN resolution_templates.body IS 'Текст шаблона.';
COMMENT ON COLUMN resolution_templates.is_active IS 'Показывать ли шаблон.';
COMMENT ON COLUMN resolution_templates.sort_order IS 'Порядок в списке.';

COMMENT ON TABLE resolutions IS 'Резолюции по документам.';
COMMENT ON COLUMN resolutions.id IS 'Идентификатор резолюции.';
COMMENT ON COLUMN resolutions.document_id IS 'Документ, к которому относится резолюция.';
COMMENT ON COLUMN resolutions.text IS 'Текст поручения.';
COMMENT ON COLUMN resolutions.source_text IS 'Исходный текст до правок.';
COMMENT ON COLUMN resolutions.source_kind IS 'Источник: manual, ai, email, forwarded.';
COMMENT ON COLUMN resolutions.status IS 'Состояние резолюции.';
COMMENT ON COLUMN resolutions.priority IS 'Приоритет поручения.';
COMMENT ON COLUMN resolutions.deadline IS 'Срок исполнения.';
COMMENT ON COLUMN resolutions.prepared_by IS 'Кто подготовил резолюцию.';
COMMENT ON COLUMN resolutions.approved_by IS 'Кто утвердил резолюцию.';
COMMENT ON COLUMN resolutions.approved_at IS 'Когда резолюция утверждена.';
COMMENT ON COLUMN resolutions.approval_method IS 'Способ утверждения: app или email.';
COMMENT ON COLUMN resolutions.confirmed_by IS 'Кто подтвердил ответ письмом.';
COMMENT ON COLUMN resolutions.confirmed_at IS 'Когда подтверждён ответ письмом.';
COMMENT ON COLUMN resolutions.dispatched_by IS 'Кто передал поручение исполнителям.';
COMMENT ON COLUMN resolutions.dispatched_at IS 'Когда поручение передано исполнителям.';
COMMENT ON COLUMN resolutions.request_email_id IS 'ID письма-запроса руководителю.';
COMMENT ON COLUMN resolutions.approval_email_id IS 'ID письма-ответа руководителя.';
COMMENT ON COLUMN resolutions.dispatch_email_id IS 'ID письма-поручения исполнителям.';
COMMENT ON COLUMN resolutions.created_at IS 'Когда резолюция создана.';
COMMENT ON COLUMN resolutions.updated_at IS 'Когда резолюция изменена.';

COMMENT ON TABLE resolution_assignees IS 'Исполнители резолюции и их отчёты.';
COMMENT ON COLUMN resolution_assignees.resolution_id IS 'Резолюция.';
COMMENT ON COLUMN resolution_assignees.user_id IS 'Исполнитель.';
COMMENT ON COLUMN resolution_assignees.kind IS 'Роль исполнителя: responsible или coexecutor.';
COMMENT ON COLUMN resolution_assignees.received_at IS 'Когда исполнитель получил поручение.';
COMMENT ON COLUMN resolution_assignees.report_text IS 'Текст отчёта исполнителя.';
COMMENT ON COLUMN resolution_assignees.report_at IS 'Когда отчёт принят.';
COMMENT ON COLUMN resolution_assignees.report_email_id IS 'ID письма-отчёта в почтовой SQLite.';
COMMENT ON COLUMN resolution_assignees.report_summary IS 'Краткая суть отчёта, предложенная моделью.';
COMMENT ON COLUMN resolution_assignees.report_proposed_at IS 'Когда модель предложила отчёт.';
COMMENT ON COLUMN resolution_assignees.created_at IS 'Когда исполнитель назначен.';

COMMENT ON TABLE resolution_approvals IS 'История шагов утверждения и передачи резолюции.';
COMMENT ON COLUMN resolution_approvals.id IS 'Идентификатор шага.';
COMMENT ON COLUMN resolution_approvals.resolution_id IS 'Резолюция.';
COMMENT ON COLUMN resolution_approvals.step IS 'Шаг: requested, approved, rejected, confirmed, dispatched, closed, cancelled.';
COMMENT ON COLUMN resolution_approvals.actor_id IS 'Кто выполнил шаг; без FK, чтобы история сохранялась.';
COMMENT ON COLUMN resolution_approvals.actor_name IS 'ФИО автора шага на момент события.';
COMMENT ON COLUMN resolution_approvals.method IS 'Способ шага: app, email или manual.';
COMMENT ON COLUMN resolution_approvals.comment IS 'Комментарий к шагу.';
COMMENT ON COLUMN resolution_approvals.email_id IS 'ID письма, если шаг связан с почтой.';
COMMENT ON COLUMN resolution_approvals.created_at IS 'Время шага.';

COMMENT ON TABLE notifications IS 'Уведомления центра уведомлений.';
COMMENT ON COLUMN notifications.id IS 'Идентификатор уведомления.';
COMMENT ON COLUMN notifications.user_id IS 'Получатель уведомления.';
COMMENT ON COLUMN notifications.kind IS 'Вид уведомления.';
COMMENT ON COLUMN notifications.entity_type IS 'Тип объекта уведомления.';
COMMENT ON COLUMN notifications.entity_id IS 'Идентификатор объекта уведомления.';
COMMENT ON COLUMN notifications.title IS 'Заголовок уведомления.';
COMMENT ON COLUMN notifications.body IS 'Текст уведомления.';
COMMENT ON COLUMN notifications.severity IS 'Важность: info, warning, danger.';
COMMENT ON COLUMN notifications.dedupe_key IS 'Ключ идемпотентности уведомления.';
COMMENT ON COLUMN notifications.created_at IS 'Когда уведомление создано.';
COMMENT ON COLUMN notifications.read_at IS 'Когда уведомление прочитано; NULL — непрочитано.';

COMMENT ON TABLE notification_templates IS 'Шаблоны текстов уведомлений.';
COMMENT ON COLUMN notification_templates.key IS 'Вид уведомления.';
COMMENT ON COLUMN notification_templates.title IS 'Шаблон заголовка.';
COMMENT ON COLUMN notification_templates.body IS 'Шаблон текста.';
COMMENT ON COLUMN notification_templates.is_active IS 'Включён ли вид уведомления.';
COMMENT ON COLUMN notification_templates.updated_at IS 'Когда шаблон изменён.';

COMMENT ON TABLE mail_sort_rules IS 'Правила сортировки почты; только подсказки, не регистрация.';
COMMENT ON COLUMN mail_sort_rules.id IS 'Идентификатор правила.';
COMMENT ON COLUMN mail_sort_rules.name IS 'Название правила.';
COMMENT ON COLUMN mail_sort_rules.is_active IS 'Включено ли правило.';
COMMENT ON COLUMN mail_sort_rules.sort_order IS 'Порядок применения.';
COMMENT ON COLUMN mail_sort_rules.match_from IS 'Условие по отправителю.';
COMMENT ON COLUMN mail_sort_rules.match_to IS 'Условие по получателю.';
COMMENT ON COLUMN mail_sort_rules.match_subject IS 'Условие по теме.';
COMMENT ON COLUMN mail_sort_rules.label IS 'Метка, которую ставит правило.';
COMMENT ON COLUMN mail_sort_rules.priority IS 'Подсказка приоритета.';
COMMENT ON COLUMN mail_sort_rules.note IS 'Подсказка аппарату.';
COMMENT ON COLUMN mail_sort_rules.created_by IS 'Кто создал правило.';
COMMENT ON COLUMN mail_sort_rules.created_at IS 'Когда правило создано.';
COMMENT ON COLUMN mail_sort_rules.updated_at IS 'Когда правило изменено.';

COMMENT ON TABLE user_activity_stats IS 'Агрегат активности пользователей для будущих подсказок.';
COMMENT ON COLUMN user_activity_stats.user_id IS 'Пользователь.';
COMMENT ON COLUMN user_activity_stats.documents_registered IS 'Сколько документов зарегистрировал.';
COMMENT ON COLUMN user_activity_stats.tasks_assigned IS 'Сколько задач назначено.';
COMMENT ON COLUMN user_activity_stats.tasks_reported IS 'Сколько отчётов сдано.';
COMMENT ON COLUMN user_activity_stats.tasks_open IS 'Сколько задач открыто.';
COMMENT ON COLUMN user_activity_stats.tasks_overdue IS 'Сколько задач просрочено.';
COMMENT ON COLUMN user_activity_stats.resolutions_prepared IS 'Сколько резолюций подготовил.';
COMMENT ON COLUMN user_activity_stats.resolutions_approved IS 'Сколько резолюций утвердил.';
COMMENT ON COLUMN user_activity_stats.resolutions_dispatched IS 'Сколько резолюций передал исполнителям.';
COMMENT ON COLUMN user_activity_stats.avg_execution_days IS 'Среднее время исполнения.';
COMMENT ON COLUMN user_activity_stats.correspondence_orgs IS 'Топ организаций-корреспондентов.';
COMMENT ON COLUMN user_activity_stats.top_tags IS 'Топ тегов.';
COMMENT ON COLUMN user_activity_stats.top_categories IS 'Топ категорий.';
COMMENT ON COLUMN user_activity_stats.request_departments IS 'Топ подразделений-заявителей.';
COMMENT ON COLUMN user_activity_stats.authors IS 'Топ авторов.';
COMMENT ON COLUMN user_activity_stats.raw_fingerprint IS 'Хэш исходных данных для пропуска пересчёта.';
COMMENT ON COLUMN user_activity_stats.computed_at IS 'Когда агрегат посчитан.';

COMMENT ON TABLE user_activity_stats_monthly IS 'Месячная разбивка агрегата активности.';
COMMENT ON COLUMN user_activity_stats_monthly.user_id IS 'Пользователь.';
COMMENT ON COLUMN user_activity_stats_monthly.period IS 'Месяц в формате ГГГГ-ММ.';
COMMENT ON COLUMN user_activity_stats_monthly.documents_registered IS 'Документов за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.tasks_assigned IS 'Задач за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.tasks_reported IS 'Отчётов за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.correspondence_orgs IS 'Топ организаций за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.top_tags IS 'Топ тегов за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.top_categories IS 'Топ категорий за месяц.';
COMMENT ON COLUMN user_activity_stats_monthly.computed_at IS 'Когда агрегат посчитан.';

COMMENT ON TABLE docflow_migrations IS 'Применённые миграции схемы документооборота.';
COMMENT ON COLUMN docflow_migrations.version IS 'Номер миграции.';
COMMENT ON COLUMN docflow_migrations.name IS 'Имя миграции.';
COMMENT ON COLUMN docflow_migrations.applied_at IS 'Когда миграция применена.';
`
  },
  {
    // Пользовательские ссылки тоже оформляем внешними ключами. ON DELETE SET NULL
    // сохраняет документы и историю, но не оставляет «висячих» идентификаторов.
    version: 15,
    name: "user_references_fk",
    sql: `
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('users', 'manager_id'),
      ('documents', 'created_by'),
      ('document_emails', 'linked_by'),
      ('resolutions', 'prepared_by'),
      ('resolutions', 'approved_by'),
      ('resolutions', 'confirmed_by'),
      ('resolutions', 'dispatched_by'),
      ('resolution_approvals', 'actor_id'),
      ('number_archives', 'created_by'),
      ('mail_sort_rules', 'created_by')
    ) AS v(tbl, col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = r.tbl || '_' || r.col || '_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE SET NULL',
        r.tbl, r.tbl || '_' || r.col || '_fkey', r.col
      );
    END IF;
  END LOOP;
END $$;
`
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
