# AGENTS.md

Справочник для агентов и разработчиков, работающих с MailSense.
Читай целиком перед изменениями — здесь собраны неочевидные ограничения, из-за которых легко сломать сборку.

## Что это

MailSense — десктопный «почтовый помощник с ИИ-аналитикой» (Electron + React). Подключается к IMAP/POP3,
забирает письма и вложения в SQLite, прогоняет их через staged-пайплайн из двух ИИ-моделей
(OCR + summary) и показывает структурированную выжимку (суть, теги, приоритет, дата события,
внешний номер, дата отправки, категория) в трёхпанельном UI.

Стек: pnpm workspace · TypeScript · React 18 + Ant Design + Zustand · Express · better-sqlite3 + drizzle-orm ·
imapflow (IMAP) + собственный POP3-клиент · openai (llama.cpp) · electron-builder.

## Быстрый старт

```bash
make install          # или: pnpm install
make build            # core + server + web + electron
make run              # headless-сервер: http://127.0.0.1:8123
make test             # юнит-тесты
make package-linux    # .deb
make package-win      # Windows zip
```

## Структура (pnpm workspace)

```
packages/core      # домен: БД, почта, вложения, ИИ, очередь, сервисы (без Electron/UI)
packages/server    # Express REST API + раздача SPA + standalone-запуск
packages/web       # React SPA (Vite): App.tsx + components/
apps/electron      # Electron-оболочка: main.ts (ESM), preload.ts, electron-builder
scripts/           # test_pop3.mjs — интеграционный тест POP3
Makefile           # цели сборки
```

## Архитектура

- **Рендерер общается по HTTP REST** (не через IPC). Один и тот же бэкенд (`startServer`) работает
  headless (Node, для тестов) и внутри Electron (в `app.whenReady`). Это нужно и для тестов, и для упаковки.
- Путь данных: коннектор (IMAP/POP3) → `mailparser` → SQLite + файлы вложений на диске → очередь `p-queue` →
  ИИ-адаптер (OpenAI-совместимый) → валидация JSON (zod) → `analysis_results`.
- Статусы анализа: `pending` → `queued` → `processing` → `ready` | `error`.
- Вложения: изображения → OCR-модель (base64); PDF → рендер страниц в PNG (pdfjs-dist + @napi-rs/canvas) →
  OCR-модель постранично; DOCX → текст (mammoth) + вложенные картинки; XLSX → структурированный текст (xlsx).
- Staged-пайплайн: сначала OCR-модель (`glm-ocr`) читает страницы вложений параллельно (`ocrQueue`),
  затем summary-модель делает финальную выжимку text-only (`analysisQueue`). Параллельность каждой
  настраивается в «Настройки → ИИ» (`concurrency` / `ocrConcurrency`).

## Команды (по пакетам)

```bash
pnpm --filter @mailsense/core build        # tsup → dist (ESM, --dts)
pnpm --filter @mailsense/server build
pnpm --filter @mailsense/web build         # vite build
pnpm --filter @mailsense/web typecheck     # tsc --noEmit
pnpm --filter mailsense-electron build     # tsup: main.js (ESM) + preload.cjs
pnpm --filter @mailsense/core test         # Jest (13 тестов)
node scripts/test_pop3.mjs                 # интеграционный тест POP3
```

## Критично: нативные модули и версии

1. **better-sqlite3@13 — N-API 10, только Node 22+.** Бинарники лежат прямо в npm-пакете
   (`prebuilds/`, `gypfile: false`) — компиляция НЕ нужна. НЕ понижай Electron ниже 35 (Node 20.18 = N-API 9):
   `new Database()` упадёт. Электрон 35 (Node 22.16, N-API 10) — выбран специально под better-sqlite3@13.
2. **@napi-rs/canvas** — платформенные бинарники через `optionalDependencies` с `os`/`cpu`-гейтами.
   На Linux НЕ ставится `@napi-rs/canvas-win32-x64-msvc` → для Windows-сборки он выложен вручную в
   `apps/electron/vendor/canvas-win32-x64-msvc/` и подключается через `win.extraResources`.
3. **Компиляция нативных модулей ломается в путях с пробелами/кириллицей** (например,
   `/home/user/Рабочий стол/...`). v13 это не нужно (prebuilds). Если когда-то понадобится собирать
   node-gyp — делай это в каталоге без пробелов.

## Критично: pnpm и build-скрипты

- pnpm 11 **игнорирует** поле `pnpm` в корневом `package.json` (был `pnpm.onlyBuiltDependencies` — не работает).
- Разрешение postinstall задаётся в **`pnpm-workspace.yaml`** ключом `allowBuilds` (map `имя: true/false`).
- Сейчас: `better-sqlite3: false` (prebuilds, не нужен), `esbuild: true`, `electron: true` (скачивает бинарник).
- Бинарник Electron скачивается в `~/.cache/electron` (переменная `XDG_CACHE_HOME`; `ELECTRON_CACHE` НЕ работает).
- electron-builder кэширует в `~/.cache/electron-builder` (переменная `ELECTRON_BUILDER_CACHE`).

## Упаковка (apps/electron)

- **core+server бандлятся в `main.js`** (tsup, ESM) — см. `apps/electron/tsup.config.ts`. Нативные
  (`better-sqlite3`, `@napi-rs/canvas`) и `pdfjs-dist` остаются external. `main.ts` — ESM (`import.meta.url`),
  `preload.cjs` — CJS.
- ⚠️ **CJS-пакеты с динамическим `require()` нельзя бандлить в ESM `main.js`** — при старте падает
  `Dynamic require of "..." is not supported`. Пример: `@kenjiuno/msgreader` (тянет `iconv-lite` → `safer-buffer`).
  Такие пакеты добавляй в `dependencies` у `apps/electron/package.json` (останутся external), а не только в `@mailsense/core`.
- `electron-builder` конфиг — в `apps/electron/package.json` (поле `build`): `asarUnpack: ["**/*.node"]`,
  `npmRebuild: false` (N-API не требует пересборки), web-дист через `extraResources`.
- **Windows NSIS-инсталлятор требует wine** (недоступен без sudo). Поэтому `win.target: ["zip"]` +
  `signAndEditExecutable: false`. На машине с wine/Windows можно вернуть `nsis`.
- **Linux: `.deb`** (chrome-sandbox получает setuid через postinst → песочница работает без флагов).
- Артефакты: `apps/electron/release/` → `*.deb` (Linux), `*-win.zip` (Windows).

## TLS и self-signed

- `rejectUnauthorized` по умолчанию **false** (принимаем self-signed, как на проде MDaemon).
  Смысл поля: `settings.rejectUnauthorized === true` → строгий режим.

## Тестовый стенд (см. `/home/user/Рабочий стол/test mail/README.md`)

- Почта (docker-mailserver): `test@mail.test` / `Test1234!`; IMAP 993 (TLS), POP3 995/110 (SSL/STLS/plain),
  self-signed. Хост `127.0.0.1` (локально) или `192.168.21.83` (LAN).
- ИИ (llama.cpp): `http://10.70.203.245:3010/v1`; OCR-модель `glm-ocr`, summary-модель `qwen-3.5-9b`
  (у summary отключено мышление через `chat_template_kwargs:{enable_thinking:false}`, иначе JSON обрезается).
- E2E UI — через Playwright MCP (открыть `http://127.0.0.1:8123`).

## Конфигурация (env)

См. `packages/core/src/config.ts`. Ключевые: `MAILSENSE_DATA_DIR`, `MAILSENSE_PORT` (8123),
`MAILSENSE_AI_BASE_URL`, `MAILSENSE_AI_MODEL`, `MAILSENSE_MAIL_HOST`/`_PORT`/`_USER`/`_PASS`, `MAILSENSE_SEED_ACCOUNT`.

Дефолтный аккаунт засевается **только** если `MAILSENSE_SEED_ACCOUNT=true` И заданы `MAILSENSE_MAIL_USER`+`MAILSENSE_MAIL_PASS`.
По умолчанию (`false`) ничего не засевается — в сборке жёстко зашитых учётных данных нет.

## Частые подводные камни

- Seeding тестового аккаунта выключен по умолчанию. Для локального стенда задай env:
  `MAILSENSE_SEED_ACCOUNT=true MAILSENSE_MAIL_USER=test@mail.test MAILSENSE_MAIL_PASS=Test1234!`
  (или добавь аккаунт через окно настроек).
- Пароли: в Electron — `safeStorage`, иначе фолбэк AES-256-GCM (ключ в `data/secret.key`).
- POP3: после `RETR`/`UIDL` сначала идёт строка статуса `+OK …` — её нужно читать отдельно от тела (см. `pop3Client.ts`).

## Почта: диапазон дат, авто-скан, переписки

- **Диапазон дат в IMAP.** Не передавай в `imapflow.fetch()` объект `{since, before}`: библиотека компилирует
  `BEFORE`/`SINCE` в расширение `WITHIN` (`OLDER`/`YOUNGER`), которое Dovecot отвергает
  (`BAD Invalid search interval parameter`) — и скан молча возвращает 0 писем. В `imapConnector.ts` сначала
  получается СПИСОК UID (`SEARCH SENTSINCE/SENTBEFORE` при диапазоне, иначе `SEARCH ALL`), из него вычитаются
  `knownUids`, и только после этого качаются тела (`fetch(uidList, {source:true, uid:true}, {uid:true})`,
  пачками по 500). Нельзя снова скачивать весь ящик через `fetch("1:*")` и фильтровать уже полученные письма —
  на большом ящике скан без периода выглядит «зависшим». Фолбэк на `1:*` — только если SEARCH упал.
  Плюс `mailService` фильтрует по `Date` на клиенте (в локальной зоне) — как страховка и для POP3.
- **POP3** серверного поиска по датам не имеет: скачиваются все неизвестные UID, диапазон применяется клиентски.
- **Удаление и повторный скан.** Удалённые письма пишутся в `deleted_emails` (надгробия): авто-скан
  (`includeDeleted=false`) не воскрешает их, а ручной скан по `POST /api/accounts/:id/fetch` передаёт
  `includeDeleted=true` — тогда UID/Message-ID надгробий не считаются известными и письма скачиваются заново
  (`clearDeletedEmail` снимает надгробие). Иначе «удалил → скан» навсегда ничего не возвращает.
- **Вложения: текст и описание.** OCR/извлечённый текст сохраняется в `attachments.extracted_text`
  (`setAttachmentText` из `analysisService`), а описания модели — в `ai_description`. Сопоставление описаний
  с вложениями идёт через `matchAttachmentDescriptions` (регистр/путь/пробелы/расширение), а не строгим
  сравнением `filename` — иначе часть вложений остаётся без «краткого содержания».
- **Авто-скан НЕ сканирует весь ящик.** Планировщик берёт `account.settings.lastFetchAt` и забирает письма
  начиная с него (минус сутки запаса). Пока синхронизации не было, авто-скан молчит — первичный скан запускает
  пользователь кнопкой «Скан» (при необходимости с диапазоном дат). Отключение — настройка `auto_fetch=false`
  («Настройки → Общие»). Параллельные сканы одного аккаунта сериализуются в `mailService` (иначе
  «Connection not available» / socket timeout).
- **Переписки** (`services/threadService.ts`): приоритет — In-Reply-To/References; если родителя нет в БД,
  ответы склеиваются по нормализованной теме (`Re:`/`Fwd:`/`Ответ:` срезаются, в т.ч. внутри строки);
  письма без признаков ответа с одинаковой темой НЕ склеиваются (рассылки). Родитель, пришедший позже детей,
  «усыновляет» их. При апгрейде беседы один раз пересобираются целиком — гейт `settings.maintenance.version`
  (см. `services/maintenance.ts`). Ручная пересборка: `POST /api/threads/rebuild` (тело `{accountId?}`).
- **Статус «Готово»** ставится только после успешного анализа. Ответы внутри переписки больше НЕ помечаются
  готовыми без анализа: при `auto_analyze=false` они остаются «Ожидает».
- **Письма: ответ/пересылка, подпись.** Шаблон для композера собирает `GET /api/compose-template`
  (`services/composeService.ts`): получатели (Reply-To → From), тема без дублей `Re:`/`Fwd:`, цепочка
  `References` = references оригинала + Message-ID родителя (`buildReferences`), строка атрибуции,
  цитата (`>` в text/plain, `<blockquote>` в HTML) и подпись. Подпись и отображаемое имя — в
  `account.settings` (`displayName`, `signature`, `signatureHtml`, `signatureEnabled`,
  `signaturePosition`, `signatureDelimiter`, `replyQuote`, `replyAttribution`, `forwardAttachments`) и правятся в
  «Настройки → Аккаунты → Отправка и подпись». Пересылка прикладывает вложения оригинала.
  `signatureHtml` — подпись из WYSIWYG-редактора (приоритет), `signature` — plain-зеркало для text/plain.
  ⚠️ Редактор TipTap отдаёт HTML; text/plain собирается `htmlToPlainText` (blockquote → `>`), а не
  `editor.getText()` — иначе цитата теряет `>`.
  ⚠️ Адреса в «Кому/Копия» разбирает `parseEmails` (Composer.tsx) НЕ через split: имя вида
  «Иванов, И.И. <a@b>" не должно рваться по запятой, поэтому ищутся готовые адреса
  (`"Имя" <a@b>` / `Имя <a@b>` / `a@b`), а разделители просто игнорируются. В `AddressSelect`
  `tokenSeparators={[";"]}` — запятая намеренно НЕ разделитель (иначе имя рвётся при вводе).
- **Единый WYSIWYG-редактор.** `components/RichTextEditor.tsx` (TipTap StarterKit + Placeholder) — один
  редактор на композер, шаблоны и подпись: панель с заголовками, списками, цитатой, ссылкой и «Tx».
  Не плодить второй экземпляр TipTap — переиспользовать этот компонент.
- **Шаблоны писем.** «Настройки → Шаблоны»: список + кнопка «Добавить шаблон», форма — в **попапе**
  (встроенной формы под списком больше нет). Сохраняются `bodyHtml` (WYSIWYG) и `bodyText` (plain-фолбэк).
  ⚠️ Модалка настроек НЕ размонтирует вкладки, поэтому в `SettingsModal` они пересоздаются по `reloadKey`
  при каждом открытии — иначе список шаблонов (и статус каталога) остаются устаревшими и сохранённый
  из композера шаблон «не появляется» в настройках.
- **Каталог LDAP/AD (адресная книга).** Вход опционален (`services/directoryService.ts`, `directory/ldap.ts`, `ldapts`):
  bind от учётки пользователя, пароль — зашифрованно (`settings`: `ldap.login`/`ldap.passwordEncrypted`). Настройки —
  `ldap.*` (`url`, `baseDn`, `loginFormat`, `upnSuffix`, `netbiosDomain`, `userFilter`, `attributes`, `sizeLimit`,
  `rejectUnauthorized`), UI — «Настройки → Каталог (LDAP)». Автокомплит адресов — `GET /api/contacts/search`
  (кэш таблицы `contacts` + онлайн-дополнение). ⚠️ `upnSuffix` может содержать ведущий `@` — не удваивать
  (`buildBindIdentifier`). Стенд: `stand.test`, `ldaps://127.0.0.1:636`, bind `test`/`Test1234!` (плейн 389 Samba не пускает).
  ⚠️ `ldapts` объявлен в `dependencies` и у `@mailsense/core`, и у `apps/electron` (external для tsup) — иначе
  electron-builder не положит его в asar.
