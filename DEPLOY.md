# Развёртывание MailSense (офлайн)

Готовые артефакты лежат в apps/electron/release/ и не требуют интернета при установке/запуске.

## Артефакты

| Файл | ОС | Как запустить |
|---|---|---|
| mailsense-electron_0.1.1_amd64.deb | Linux x64 (Debian/Ubuntu) | sudo apt install ./mailsense-electron_0.1.1_amd64.deb — появится «MailSense» в меню |
| MailSense-0.1.1-win.zip | Windows x64 | распаковать архив и запустить MailSense.exe |

> Windows: вместо инсталлятора здесь zip-архив (папка win-unpacked/ — то же самое без архива).
> NSIS-установщик (.exe setup) собрать в этой среде нельзя — для него нужен wine или сборка на Windows.

## Конфигурация

Параметры задаются в окне «Настройки» приложения или переменными окружения:

| Переменная | По умолчанию | Что это |
|---|---|---|
| MAILSENSE_MAIL_HOST | 127.0.0.1 | почтовый сервер (IMAP/POP3) |
| MAILSENSE_MAIL_PORT | 993 | порт IMAP |
| MAILSENSE_MAIL_USER / _PASS | — | логин/пароль аккаунта |
| MAILSENSE_AI_BASE_URL | http://localhost:8080/v1 | OpenAI-совместимый endpoint |
| MAILSENSE_AI_MODEL | (пусто) | имя summary-модели |
| MAILSENSE_PORT | 8123 | порт встроенного сервера |

Аккаунт по умолчанию не создаётся (seeding выключен) — добавьте почту и ИИ-эндпоинт через настройки.
OCR-модель, её base URL и параллельность (summary/OCR) задаются в окне «Настройки → ИИ».

## Куда сохраняются данные

- БД SQLite и вложения — в каталог данных приложения (userData).
- Пароли шифруются (Electron safeStorage, фолбэк — AES-256-GCM).

## Сборка заново

```bash
pnpm install
make build                                # core + server + web + electron
cd apps/electron && pnpm dist:linux      # .deb
cd apps/electron && pnpm dist:win        # zip (Windows)
```

Для Windows-NSIS-инсталлятора собери на машине с wine или на Windows.

## Примечания

- better-sqlite3@13 и @napi-rs/canvas — N-API (ABI-стабильные), работают и в Node, и в Electron (35+).
- Электрон 35 (Node 22.16, N-API 10) выбран под better-sqlite3@13.