# MailSense — Почтовый помощник с ИИ-аналитикой

Desktop-приложение (Electron + React) для автоматической обработки входящей почты:
подключение IMAP/POP3, извлечение текста и вложений, мультимодальный ИИ-анализ,
трёхпанельный UI в стиле Outlook.

## Возможности

- **Почта**: IMAP (imapflow) и POP3 (собственный клиент, none/ssl/starttls), мультиаккаунтность.
- **ИИ**: OpenAI-совместимый endpoint (llama.cpp / Ollama / vLLM), мультимодальная модель (text + image).
- **Вложения**: изображения → vision (base64); PDF → рендер страниц в PNG → vision;
  DOCX → текст (mammoth) + вложенные картинки; XLSX → структурированный текст.
- **Результат** (JSON): summary, tags[], priority (1–5), urgent, event_date, category (work/personal/spam).
- **UI**: трёхпанельный макет (аккаунты/папки · список писем · просмотр + анализ),
  редактирование анализа, фильтры (по категориям, статусу, приоритету, тегу), пакетные операции,
  импорт .eml/.mbox, сканирование и анализ по диапазону дат.
- **Хранение**: SQLite (better-sqlite3 + drizzle-orm), вложения на диске, пароли шифруются
  (AES-256-GCM; в Electron — safeStorage).
- **Очередь**: p-queue (in-memory), остановка анализа с очисткой очереди, автоанализ по расписанию.

## Структура (pnpm workspace)

| Пакет | Назначение |
|---|---|
| packages/core | Домен: БД, почтовые коннекторы, обработка вложений, ИИ-адаптер, очередь, сервисы |
| packages/server | Express REST API + раздача собранного SPA + standalone-запуск |
| packages/web | React 18 + Ant Design + Zustand + react-window |
| apps/electron | Electron-оболочка (main/preload) + electron-builder |

## Быстрый старт

```bash
pnpm install
make build                 # core + server + web + electron
make run                   # headless-сервер: http://127.0.0.1:8123
```

Откройте http://127.0.0.1:8123, добавьте почтовый аккаунт и ИИ-эндпоинт через «Настройки».

## Сборка дистрибутивов

```bash
make package-linux         # AppImage + .deb → apps/electron/release/
make package-win           # Windows zip   → apps/electron/release/
```

- **Linux**: .deb — предпочтительно (chrome-sandbox получает setuid через postinst).
  AppImage требует --no-sandbox (зашит в main.ts).
- **Windows**: zip-архив. NSIS-установщик (.exe setup) собирается на Windows или через wine.

## Конфигурация (переменные окружения)

См. packages/core/src/config.ts. Основные:

| Переменная | По умолчанию | Описание |
|---|---|---|
| MAILSENSE_DATA_DIR | ./data | каталог данных (SQLite, вложения, логи) |
| MAILSENSE_PORT | 8123 | порт встроенного сервера |
| MAILSENSE_AI_BASE_URL | http://localhost:8080/v1 | OpenAI-совместимый endpoint |
| MAILSENSE_AI_MODEL | (пусто) | имя модели (настраивается в UI) |
| MAILSENSE_MAIL_HOST / _PORT / _USER / _PASS | — | аккаунт по умолчанию (только если заданы логин+пароль) |
| MAILSENSE_SEED_ACCOUNT | false | авто-создание аккаунта из env (для стенда) |

Все настройки также доступны в окне «Настройки» приложения.

## Тестирование

```bash
make test                                  # юнит-тесты (Jest, packages/core)
node scripts/test_pop3.mjs                 # интеграционный тест POP3
```

## Релизы (GitHub)

Релизы собираются автоматически через GitHub Actions (.github/workflows/release.yml):

```bash
git tag v0.1.0
git push origin v0.1.0
```

Workflow собирает AppImage + .deb (Linux) и win.zip (Windows) и прикрепляет их к релизу.

## Примечания по реализации

- better-sqlite3@13 поставляет готовые бинарники (prebuilds/) — компиляция не требуется.
- PDF-рендер: pdfjs-dist + @napi-rs/canvas; DOCX: mammoth + jszip; XLSX: xlsx.
- Self-signed сертификаты принимаются по умолчанию (rejectUnauthorized: false).
- Один и тот же бэкенд работает headless (для тестов) и внутри Electron (для десктопа).
- Для Windows-сборки на Linux используется заранее выложенный бинарник
  @napi-rs/canvas-win32-x64-msvc из apps/electron/vendor/ (см. AGENTS.md).