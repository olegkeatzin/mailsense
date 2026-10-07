# Этап 5 — контракт и постановка (замораживает Lead)

Дата: 2026-10-07. Владелец файла: **Lead**. Интерфейсы ниже заморожены: менять только через Lead
(send_message), иначе два агента разойдутся и интеграция развалится.

## 0. Что делаем и чего НЕ делаем

Этап 5 плана — «Уведомления, сроки, автосортировка». Два конфликта зафиксированы заказчиком 2026-10-07:

1. **Уведомления — только ВНУТРИ приложения** (центр уведомлений + бейдж + шаблоны текста).
   **Писем-напоминаний НЕ отправляем** — это решение Р11 (журнал `EDMS_v0.1.4_questions.md`):
   исполнитель сам ставит задачу в календарь кнопкой «В календарь» (.ics уже есть), просрочка видна
   в приложении. ТЗ п.75 («email-напоминания») сознательно не выполняем в этой части.
2. **Правила автосортировки — маршрутизация и подсветка, а НЕ авторегистрация.** Правило помечает
   письмо меткой, приоритетом и подсказкой аппарату и поднимает его в очереди.
   **Документ по-прежнему создаёт человек** (rules.md §6.1, docs/docflow.md «Письмо размечает аппарат»).
   Правило НЕ выдаёт номер и НЕ создаёт запись в журнале ни при каких настройках.

Вне этапа: письма-напоминания, авторазбор/авторегистрация, граф знаний, drag&drop, смена формата номера.

## 1. Общие правила работы (читать всем)

- Прочитать `docs/rules.md` и `AGENTS.md` **до** работы; правила важнее скорости.
- **Сначала падающий тест, потом код** (rules §2.1, §7.2). Новая логика — новый тест, покрывающий
  поведение. Тест, который не падает на сломанном коде, бесполезен.
- **Не коммитить.** Коммитит Lead после проверки.
- **Сборку (tsc/vite/esbuild) и перезапуск сервера делает Lead.** Разработчику можно: jest своего
  пакета и `tsc --noEmit` своего пакета.
- **Jest только с `--runInBand --forceExit`** и только в своей очереди: пакеты делят PostgreSQL
  на 55432 и базу `mailsense_test` (TRUNCATE перед прогоном). Перед запуском тестов сообщить в
  командный чат Lead'у; одновременно тесты не запускает никто, кроме владельца слота.
- **Браузер Playwright ОДИН на всех.** Им пользуется только `qa-tester` (и Lead на финальной
  приёмке). Остальным — запрещено, иначе сбиваем друг другу сессии.
- **Каждый пишет только в свои файлы** (см. §9 «Области записи»). Импорт из чужого пакета — норма,
  правка чужого файла — нет: пиши владельцу.
- **Skill'ы обязательны** (см. §10). Перед действиями по теме – загрузить нужный skill, следовать ему.
- Отчёт честный: «не проверял, потому что…» — нормальный результат. Выдуманная цифра — нет.

## 2. Миграция v7 — владелец server-backend-dev

⚠️ В живой базе максимальная версия — **6** (проверено Lead'ом 2026-10-07 через `docflow_migrations`
в `mailsense` и `mailsense_test`). Следующая свободная — **7**. Сверь ещё раз сам перед работой.

```sql
-- v7: notifications_templates_and_sort_rules
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- см. §3
  entity_type TEXT NOT NULL,          -- 'resolution' | 'document'
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',   -- info | warning | danger
  dedupe_key TEXT NOT NULL,           -- уникален в пределах пользователя
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications(user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_templates (
  key TEXT PRIMARY KEY,               -- = kind из §3
  title TEXT NOT NULL,                -- шаблон с {переменными}
  body TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_sort_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  match_from TEXT NOT NULL DEFAULT '',
  match_to TEXT NOT NULL DEFAULT '',
  match_subject TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  priority INTEGER,                   -- 1..5, больше — важнее; NULL = не подсказывать
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Дефолтные шаблоны для всех `kind` из §3 сеются в миграции (`ON CONFLICT (key) DO NOTHING`),
дефолтные правила сортировки — НЕ сеем (пустой список честнее выдуманного правила).

## 3. Виды уведомлений (`kind`) — заморожено

| kind | Когда | Кому | severity |
|---|---|---|---|
| `resolution.assigned` | `dispatchResolution` — поручение ушло | каждому исполнителю | info |
| `resolution.approved` | `approveResolution` (оба пути) | `prepared_by` (аппарат) | info |
| `resolution.reported` | `reportExecution` | `prepared_by` и `approved_by` | info |
| `resolution.closed` | `closeResolution` | утвердивший + исполнители | info |
| `resolution.due_soon` | срок наступит в пределах `dueSoonDays` | исполнитель | warning |
| `resolution.due_today` | срок сегодня (`daysLeft === 0`) | исполнитель | warning |
| `resolution.overdue` | срок прошёл, отчёта нет | исполнитель | danger |
| `resolution.overdue_escalation` | срок прошёл, отчёта нет | `prepared_by` (аппарат ведёт сроки) | danger |

Правила материализации сроков (детерминированные, без cron — считаются на чтении):
- на любом чтении уведомлений/счётчика`materializeDeadlineNotifications(userId)` пересчитывает
  сроки для задач этого пользователя и создаёт недостающие строки идемпотентно по `dedupe_key`;
- `dedupe_key`: `"<kind>:<resolutionId>:<deadline>"` — один раз на срок; продление срока даёт новый ключ
  (это правильно: новый срок — новое напоминание);
- просроченная задача перестаёт быть `due_soon`/`due_today` (оба не создаются, если `daysLeft < 0`);
- закрытая/отчитавшаяся задача не напоминает: `due_*`/`overdue` только для `status='sent'` и без отчёта;
- уведомление НЕ создаётся, если исполнитель его уже прочитал по этому сроку (ключ занят);
- хранение: держим последние 500 уведомлений пользователя, более старые прочитанные удаляются на
  материализации (иначе таблица растёт вечно). Непрочитанные не удаляем.
- ⚠️ Материализация не должна ронять чтение: ошибка в ней логируется, список отдаётся как есть.

Событийные уведомления (§3, верхние 4) пишутся **в той же транзакции**, что и изменение, рядом с
`auditInTx` — либо и поручение ушло, и уведомление есть, либо ничего. Аудит при этом НЕ подменяется.

## 4. Ключи настроек (таблица `settings`, docflow)

| Ключ | Значение по умолчанию | Смысл |
|---|---|---|
| `notifications.enabled` | `"true"` | выключатель уведомлений целиком |
| `notifications.dueSoonDays` | `"3"` | за сколько дней предупреждать (замена «T−3» из макета) |
| `notifications.workdayDeadlines` | `"true"` | считать типовой срок в рабочих днях (см. §5) |

Читать через существующий `getSetting`/`setSetting`; значения валидировать (число 0..30, булево),
мусор в базе не должен ломать чтение.

## 5. Core: чистая логика — владелец client-backend-dev

`packages/core/src/services/mailSortRules.ts` (новый файл, экспорт через `@mailsense/core`):

```ts
export interface MailSortRule {
  id: string; name: string; isActive: boolean; sortOrder: number;
  matchFrom: string; matchTo: string; matchSubject: string;
  label: string; priority: number | null; note: string;
}
export interface MailSortInput { from?: string | null; to?: string | null; subject?: string | null }
export interface MailSortMatch {
  matched: boolean;
  labels: string[];            // стабильный порядок, без дублей
  notes: string[];
  priority: number | null;     // максимум среди сработавших правил
  ruleIds: string[];           // в порядке применения
}
export function validateSortRule(rule: Partial<MailSortRule>): { ok: boolean; errors: string[] };
export function matchSortRules(rules: MailSortRule[], mail: MailSortInput): MailSortMatch;
```

Семантика — заморожена:
- сравнение **регистронезависимое** и **без SQL`lower()`** (rules §5.6: кириллица): нормализация в JS
  (`toLowerCase()`), поиск подстроки `includes`, **никаких регулярных выражений** (ReDoS-защита);
- пустой матчер = «любой»; правило срабатывает, если совпали ВСЕ непустые матчеры;
- правило, у которого все три матчера пустые, — **невалидно** (`validateSortRule` → ошибка) и в матчинге
  не участвует (иначе оно ловит всю почту);
- неактивные правила игнорируются; порядок применения — `sortOrder` ASC, затем `id`;
- `priority` результата = максимум среди сработавших (больше — важнее, как в анализе письма);
- границы: `name` ≤ 120, матчеры ≤ 200, `label` ≤ 40, `note` ≤ 200, `priority` ∈ 1..5 или null;
  `validateSortRule` возвращает понятные русские тексты ошибок;
- функция **чистая**: ни БД, ни сети, ни времени.

`packages/core/src/services/workingDays.ts` (новый файл):

```ts
export function isWorkingDay(iso: string, holidays?: string[]): boolean;
export function countWorkingDays(fromIso: string, toIso: string, holidays?: string[]): number;
/** Срок «через N рабочих дней»: отсчёт начинается со СЛЕДУЮЩЕГО дня после fromIso. */
export function addWorkingDays(fromIso: string, days: number, holidays?: string[]): string;
```

- выходной = суббота/воскресенье; `holidays` — список `YYYY-MM-DD` (праздники задаёт админ,
  см. §4/`deadlines.holidays`); пустой список — тоже валидный вход;
- даты только `YYYY-MM-DD` (строка), без часовых поясов и `Date`-ловушек: считаем в UTC-полночи;
- `days = 0` → `fromIso` (если это рабочий день) или ближайший рабочий вперёд;
- кривой вход (не `YYYY-MM-DD`, `days < 0`) → `RangeError` с понятным текстом, не «тихо NaN».

## 6. API — заморожено (владелец server-backend-dev), новый файл `packages/server/src/notificationRoutes.ts`

Монтируется из `app.ts` рядом с `mountResolutionRoutes`. Служебные пути объявляются **до** `/:id`.
Права — на сервере через `requirePermission`; UI только прячет кнопки.

| Метод и путь | Право | Ответ |
|---|---|---|
| `GET /api/docflow/notifications?limit=&unread=1` | `notifications.view` | `{ items: AppNotification[], unread: number, total: number }` |
| `GET /api/docflow/notifications/count` | `notifications.view` | `{ unread: number }` — дешёвый вызов для бейджа |
| `POST /api/docflow/notifications/:id/read` | `notifications.view` | `{ ok: true, unread: number }` |
| `POST /api/docflow/notifications/read-all` | `notifications.view` | `{ updated: number, unread: 0 }` |
| `GET /api/docflow/notifications/settings` | `settings.manage` | `{ enabled, dueSoonDays, templates: NotificationTemplate[] }` |
| `PUT /api/docflow/notifications/settings` | `settings.manage` | `{ ok: true }`, аудит `notifications.settings` в той же транзакции |
| `GET /api/docflow/sorting/rules` | `settings.manage` | `{ items: MailSortRule[] }` |
| `POST /api/docflow/sorting/rules` | `settings.manage` | `{ rule }`, аудит `sorting.rule.create` в той же транзакции |
| `PATCH /api/docflow/sorting/rules/:id` | `settings.manage` | `{ rule }`, аудит `sorting.rule.update` |
| `DELETE /api/docflow/sorting/rules/:id` | `settings.manage` | `{ ok: true }`, аудит `sorting.rule.delete` |
| `POST /api/docflow/sorting/rules/preview` | `settings.manage` | `{ matched, total, samples: [...] }` — проверка правила на письмах, без записи |

**Контракт `AppNotification`** (и сервер, и web используют ровно эти имена):
```ts
{ id: string; kind: string; entityType: "resolution" | "document"; entityId: string;
  title: string; body: string; severity: "info" | "warning" | "danger";
  createdAt: string; readAt: string | null;
  deadline: string | null; daysLeft: number | null; link: string | null }   // link — раздел UI, см. §7
```

⚠️ **IDOR.** `/read` и любое чтение работают только со своими строками: запрос всегда с
`user_id = currentUser.id`; чужая запись → **404** (не 403 — 403 выдаёт её существование).
`read-all` обновляет только свои строки и возвращает число фактически обновлённых.

**Письма-напоминания не отправляются** ни одним маршрутом — этот запрет проверяется тестом
(в `sendService`/SMTP из этапа 5 не ходим вообще).

### Расширение «Входящих на регистрацию» (`GET /api/docflow/journal/incoming`)

К элементам ответа добавляются поля (имена заморожены): `sortLabels: string[]`,
`sortPriority: number | null`, `sortNotes: string[]`, `sortMatched: boolean`.
Новые query-параметры: `rulesOnly=1` (только совпавшие с правилами), `sort=rules|date`
(по умолчанию `date`). Порядок по умолчанию НЕ меняем: аппарат привык к нему.
Правила применяются `matchSortRules` из core — **никакой второй реализации матчинга**.

⚠️ Правило не создаёт документ и не трогает нумерацию: `journal.register` остаётся единственным путём.

## 7. Web (SPA) — владелец frontend-dev, дизайн — владелец ux-ui-designer

Разделы (`AppSection`) и вид уведомлений:
- бейдж в шапке: `NotificationsBell.tsx`, счётчик непрочитанных, опрос `/count` раз в 60 с **только
  при наличии права** `notifications.view` (иначе 403 в консоли — уже проходили);
- панель уведомлений: список (иконка по `severity`, заголовок, текст, время), «Прочитать все»,
  переход по клику в раздел по `link`, фильтр «непрочитанные»; пустое состояние — честный текст;
- `link` сервер отдаёт как раздел: `tasks` | `approvals` | `confirmation` | `board` | `journal` | null;
- `MyTasks.tsx` / `ResolutionBoard.tsx`: срок и просрочка с числом дней («просрочено на N дней»),
  предупреждение за N дней; кнопка «В календарь» остаётся как есть (Р11);
- `IncomingList.tsx`: чипы меток правил, подсказка аппарату, приоритет, фильтр «только по правилам»,
  переключатель сортировки; подпись прямо говорит, что **регистрирует человек**;
- `SettingsModal.tsx`: вкладка «Правила сортировки» (CRUD + предпросмотр) и блок настроек
  уведомлений (вкл/выкл, «за N дней», шаблоны) в админских вкладках;
- `store.ts`: `notifications`, `unreadCount`, `loadNotifications`, `markNotificationRead`,
  `markAllNotificationsRead`, опрос с очисткой при размонтировании (иначе утечка и гонка);
- ⚠️ Консоль пуста у каждой роли; гонки запросов не допускаем (в проекте это уже ловили — `progressPolling`).

Контракт для фронта — §3, §4, §6. Форму данных придумывать заново нельзя.

## 8. Приёмка этапа (что проверяет Lead и qa-tester)

1. **Юнит-тесты**: новые тесты падают на сломанном коде (проверка инъекцией дефекта), `--runInBand`,
   покрытие не ниже рубежа (core 612 / docflow 331 / server 182 / web 87 — рубеж только растёт).
2. **Сквозные сценарии** `scripts/test_stage5_*.mjs` на живом стенде (не на моках): уведомление о
   назначении → бейдж → прочтение; срок T−3/сегодня/просрочка; правило сортировки поднимает письмо
   в очереди и НЕ регистрирует документ; чужие уведомления недоступны (404); без права — 403.
3. **Playwright, обе роли** (администратор + рядовой/исполнитель), консоль пуста.
4. **Безопасность**: обзор `docs/security/stage5-review.md` + тесты авторизации новых маршрутов.
5. **Сборка** `tsc --declaration` без ошибок, SPA собрана, сервер перезапущен на новом коде
   (StartTime позже сборки — rules §5.2).

## 9. Области записи (не пересекаются)

| Роль | Пишет только сюда |
|---|---|
| server-backend-dev | `packages/docflow/src/**`, `packages/server/src/**` |
| client-backend-dev | `packages/core/src/**` |
| frontend-dev | `packages/web/src/**` |
| ux-ui-designer | `docs/design/**` |
| qa-tester | `scripts/test_stage5_*.mjs`, `docs/testing.md`, `docs/design/stage5-qa-report.md` |
| security-specialist | `docs/security/**`, `packages/server/src/stage5.security.test.ts` |
| Lead | `docs/design/stage5-contract.md`, сборка, перезапуск, коммит |

Общие файлы (`app.ts`, `index.ts`, `types.ts`, `store.ts`, `api.ts`) — внутри своей зоны; правку
чужой зоны согласовывать через Lead, а не «тихо поправить».

## 10. Skill'ы (обязательно)

| Роль | Skill'ы |
|---|---|
| server-backend-dev | `test-driven-development`, `api-and-interface-design`, `security-and-hardening` |
| client-backend-dev | `test-driven-development`, `source-driven-development` |
| frontend-dev | `frontend-ui-engineering`, `vercel-react-best-practices`, `test-driven-development`, `organizing-project-files` |
| ux-ui-designer | `frontend-ui-engineering`, `web-design-guidelines`, `api-and-interface-design` |
| qa-tester | `writing-tests`, `test-driven-development`, `browser-testing-with-devtools` |
| security-specialist | `security-and-hardening`, `code-review-and-quality`, `doubt-driven-development` |

Перед началом работы по теме — загрузить skill через инструмент `skill` и следовать ему.

---

# Приложение А. Уточнения Lead после T1 (UX) и T7 (Security) — 2026-10-07

Решения по пробелам, найденным ux-designer (stage5-ux.md §10) и security-specialist. Все обязательны.

**А1. Раздел confirmation действительно не смонтирован.** В AppSection он есть, но в App.tsx ветки нет:
ApprovalList с режимом confirm не рендерится нигде, и очередь аппарата «подтвердить разбор» недостижима
из интерфейса. Это ДЕФЕКТ, а не только повод для ссылки. Решение: frontend-dev добавляет ветку
section === "confirmation", пункт бокового меню (при праве resolution.dispatch) и заголовок
«На подтверждении». Серверные link остаются: tasks | approvals | confirmation | board | journal | null.

**А2. Переменные шаблонов заморожены:** {regNumber}, {summary}, {sender}, {deadline}, {daysLeft},
{text}, {author}. GET /api/docflow/notifications/settings отдаёт их с русскими подписями:
variables: { key: string; title: string }[]. UI не хардкодит список. Неизвестная переменная остаётся
в тексте как есть (видно ошибку, а не тихую пустоту); рендер — плоский текст, без HTML.

**А3. deadlines.holidays** — ключ настроек, JSON-массив дат YYYY-MM-DD, по умолчанию []. Отдаётся и
принимается в GET/PUT /api/docflow/notifications/settings полем holidays: string[] (не более 100 дат,
формат проверяется, ошибка — 400; аудит в той же транзакции). UI админа: поле «Праздничные дни»
(по одной дате в строке), пустое значение допустимо.

**А4. Видимость выключателя.** GET /api/docflow/notifications и /count дополнительно отдают
enabled: boolean (значение notifications.enabled). Иначе пользователь не отличит «уведомлений нет»
от «выключено администратором». UI обязан показать честный текст, а не пустой список.

**А5. TaskItem.dueSoon: boolean** — порог тот же notifications.dueSoonDays, что и у уведомления
resolution.due_soon. Иначе картинка в «Моих задачах» и напоминание разойдутся на границе порога.

**А6. Пагинация «Входящих» (offset) — вне этапа.** Список ограничен limit ≤ 300; интерфейс
показывает честную подпись «показаны первые N из total», а не делает вид, что показал всё.

**А7. Найденные нарушения контраста AA (существующие, не этапа 5)** — чиним в этапе 5, потому что
«привычный дефект — всё ещё дефект» (rules §7.8): счётчик-бейдж, Tag-цвета срока и «сдано»,
utils.priorityColor (#fadb14 = 1.38:1 и другие из stage5-ux.md §11). Значения — только из палитры
Ant Design, тест contrast.test.ts расширяется на все пары, которые реально используются.

**А8. Уведомления не отправляются письмами** — подтверждено повторно. Любая попытка вызвать
sendService/SMTP из кода этапа 5 — дефект и красный тест.

**А9. Сроки: рабочие дни ПОДКЛЮЧАЕМ (закрывает O-1 security-specialist).**
Настройка notifications.workdayDeadlines сейчас сохраняется, но не влияет ни на что — это незакрытый
пункт этапа, а не мелочь. Решение (минимальный вертикальный срез, без CRUD справочника):
- миграция v7 дополнительно засевает deadline_presets (ON CONFLICT DO NOTHING) и добавляет колонку
  is_workday BOOLEAN NOT NULL DEFAULT TRUE (ALTER TABLE ... ADD COLUMN IF NOT EXISTS):
  «3 рабочих дня» (days=3), «10 рабочих дней» (days=10), «30 календарных дней» (days=30, is_workday=false),
  «до конца месяца» не заводим;
- docflow: listDeadlinePresets() — активные по sort_order;
- server: GET /api/docflow/deadline-presets?from=ГГГГ-ММ-ДД (право resolution.create), ответ
  { workdayDeadlines: boolean, holidays: string[], items: [{ id, title, days, isWorkday, dueDate }] };
  dueDate = addWorkingDays(from, days, holidays), если isWorkday && workdayDeadlines, иначе календарные дни;
  from по умолчанию — сегодняшняя дата сервера; кривой from → 400;
  ⚠️ клиент вызывает БЕЗ from (решение по предложению ux-designer): «сегодня» считает сервер,
  иначе на границе суток/в другом поясе чипы показывали бы вчерашние даты;
- frontend: в форме резолюции у поля срока — подсказки-чипы с посчитанной датой (клик подставляет срок);
- полный CRUD справочника типовых сроков — ВНЕ этапа 5 (осознанно; ручной ввод срока остаётся,
  то есть работа не блокируется). Если справочник понадобится менять — отдельная задача.
Праздники из настроек обязаны быть провалидированы ДО попадания в расчёт (см. А10).

**А10. Два дефекта, найденных security-specialist, закрываем в этапе 5 (владелец server-backend).**
- D-1. validateHolidays пропускает несуществующие даты: Date.parse('2026-02-30T00:00:00Z') в V8
  НЕ даёт NaN, а переносит день (проверено Lead'ом: 2026-02-30 → 2026-03-02, 2026-04-31 → 2026-05-01).
  Требуется round-trip проверка (new Date(t).toISOString().slice(0,10) === value) в validateHolidays —
  иначе PUT с holidays:["2026-02-30"] обязан быть 400, а сейчас 200. parseHolidays при чтении обязан
  отбрасывать даты, не прошедшие round-trip: ядро (workingDays.parseDay) на такую дату бросает
  RangeError, и после А9 эта настройка попадает в расчёт.
- O-1. Приёмка А9: тест «дефект в настройке не ломает расчёт» + тест «несуществующая дата → 400».

**А11. ResolutionDetail получает daysLeft: number | null и dueSoon: boolean** (тот же
notifications.dueSoonDays). Канбан считает по ним, локального порога не заводит: иначе картинка
на карточке и напоминание разойдутся на границе порога.


