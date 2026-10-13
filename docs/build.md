# Сборка и упаковка

Всё, что ломается при сборке: нативные модули, pnpm, ограниченная песочница, Electron.

## Нативные модули и версии

1. **better-sqlite3@13 — N-API 10, только Node 22+.** Бинарники лежат прямо в npm-пакете
   (`prebuilds/`, `gypfile: false`) — компиляция НЕ нужна. НЕ понижай Electron ниже 35 (Node 20.18 = N-API 9):
   `new Database()` упадёт. Электрон 35 (Node 22.16, N-API 10) выбран специально под better-sqlite3@13.
2. **@napi-rs/canvas** — платформенные бинарники через `optionalDependencies` с `os`/`cpu`-гейтами.
   На Linux НЕ ставится `@napi-rs/canvas-win32-x64-msvc` → для Windows-сборки он выложен вручную в
   `apps/electron/vendor/canvas-win32-x64-msvc/` и подключается через `win.extraResources`.
3. **Компиляция нативных модулей ломается в путях с пробелами и кириллицей** (например,
   `/home/user/Рабочий стол/...`). v13 это не нужно (prebuilds). Если когда-то понадобится node-gyp —
   собирай в каталоге без пробелов.

## pnpm и build-скрипты

- pnpm 11 **игнорирует** поле `pnpm` в корневом `package.json` (был `pnpm.onlyBuiltDependencies` — не работает).
- Разрешение postinstall задаётся в **`pnpm-workspace.yaml`** ключом `allowBuilds` (map `имя: true/false`).
- Сейчас: `better-sqlite3: false` (prebuilds, не нужен), `esbuild: true`, `electron: true` (скачивает бинарник).
- Бинарник Electron скачивается в `~/.cache/electron` (переменная `XDG_CACHE_HOME`; `ELECTRON_CACHE` **не** работает).
- electron-builder кэширует в `~/.cache/electron-builder` (переменная `ELECTRON_BUILDER_CACHE`).

## ⚠️ Сборка в ограниченной песочнице: tsc вместо tsup

`tsup`/`esbuild` падают с `Error: spawn EPERM` — дочерний процесс не может открыть канал.
Поэтому пакеты собираются напрямую `tsc`: `outDir` уже прописан в `tsconfig.json` каждого пакета.

```bash
cd packages/core    && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration
cd packages/docflow && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration
cd packages/server  && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration
```

- ⚠️ **Сборку SPA (`pnpm --filter @mailsense/web build`) так не обойти** — Vite нужен esbuild. Нужен доступ
  шире песочницы, причём разрешение выдаётся **на сам вызов команды**, а не на программу: вложенные
  инструменты сохраняют собственную политику.
- ⚠️ **После правки core или docflow сервер нужно перезапустить**: он берёт пакеты из `dist`,
  и Node кэширует модули на старте. Иначе новые маршруты просто не появятся.
- ⚠️ После `tsc` в `dist` остаётся дерево файлов вместо бандла `tsup` — это нормально: старая сборка
  перезаписывается, осиротевшие чанки безвредны.
- ✅ **Сборка обязана давать 0 ошибок, включая режим с объявлениями (`--declaration`).**
  Раньше здесь стояло «`TS2742` в `analysis/queue.ts` — известные, не мешают, ориентируйся на код
  возврата». Это было **вредное правило**: ошибка возникала при генерации `.d.ts`, из-за неё
  у потребителей пакета (`server`, `electron`) пропадал тип очереди. Починено явной аннотацией
  (`analysisQueue: PQueue`), сборка теперь даёт 0.
  ⚠️ Если снова увидишь формулировку «известные ошибки, можно игнорировать» — это признак, что
  дефект нормализовали, а не что он безвреден. Разберись, что именно ломается у потребителя.

## ⚠️ Перезапуск сервера: старый процесс держит порт

⚠️ **`Get-CimInstance` по `node.exe` может НЕ видеть работающий сервер** (проверено 2026-10-06:
вернул пусто, тогда как процесс слушал порт). Если искать процесс только им, создаётся ложное
впечатление, что сервер не запущен, и правка «есть в коде, но нет эффекта» ищется часами.
Надёжный порядок: `netstat -ano | Select-String ":8123.*LISTENING"` → PID в последней колонке →
`Stop-Process -Id <PID> -Force` → убедиться, что `netstat` по 8123 пуст → запускать.
Проверить, что поднялся ИМЕННО новый код: `Get-Process -Id <PID> | Select StartTime` должен быть
ПОЗЖЕ времени сборки `dist`. Отправка письма без этого «работает» на старой сборке.

При перезапуске старый Node-процесс продолжает слушать порт, новый молча падает с `EADDRINUSE`,
и тесты бьют **в старую сборку**. Один раз это уже выглядело как ошибка в коде.

Останавливать надо по командной строке процесса, а не только через задачу:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dist/bin/server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Упаковка (apps/electron)

- **core+server бандлятся в `main.js`** (tsup, ESM) — см. `apps/electron/tsup.config.ts`. Нативные
  (`better-sqlite3`, `@napi-rs/canvas`) и `pdfjs-dist` остаются external. `main.ts` — ESM (`import.meta.url`),
  `preload.cjs` — CJS.
- ⚠️ **CJS-пакеты с динамическим `require()` нельзя бандлить в ESM `main.js`** — при старте падает
  `Dynamic require of "..." is not supported`. Пример: `@kenjiuno/msgreader` (тянет `iconv-lite` → `safer-buffer`).
  Такие пакеты добавляй в `dependencies` у `apps/electron/package.json` (останутся external), а не только
  в `@mailsense/core`.
- ⚠️ **В пакет попадают ТОЛЬКО зависимости `apps/electron`.** Если код рабочей области тянет пакет,
  которого там нет, приложение упадёт уже у пользователя. Так и случилось: `pg` был у `packages/docflow`,
  но не у `apps/electron` — релизный zip падал при запуске с
  `Cannot find package 'pg' imported from ... driver.js` (драйвер PostgreSQL нужен, даже когда СЭД
  выключена: код импортируется при старте).

  **Правило:** новая зависимость `core`/`docflow`/`server` — это ещё и зависимость `apps/electron`
  (либо она сознательно переводится в бандл). Следят за этим двое:

  1. `node apps/electron/scripts/check-deps.mjs` — запускается автоматически перед каждой упаковкой
     (в скриптах `dist:win`, `dist:deb`, `dist:linux`), падает с перечнем пропущенного;
  2. тест `packages/server/src/packagingDeps.test.ts` — тот же инвариант в общем прогоне тестов.

  ⚠️ **Проверять надо и собранный пакет, а не только манифест.** Минимум — запустить приложение
  из `release/win-unpacked` (или `linux-unpacked`). Без графики годится такая проверка: распаковать
  `app.asar` и загрузить зависимости тем же Electron в режиме Node:

  ```bash
  # Windows: asar-утилита лежит в node_modules, бинарник — в собранном пакете
  node node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar/bin/asar.js \
    extract apps/electron/release/win-unpacked/resources/app.asar /tmp/asar
  # затем из /tmp/asar: ELECTRON_RUN_AS_NODE=1 <...>/MailSense.exe check-load.cjs
  #   где check-load.cjs по очереди require(...) каждую рантайм-зависимость и печатает пропущенные
  ```

  Проверено на исправленном пакете: «ВСЕ 20 ЗАВИСИМОСТЕЙ ЗАГРУЖАЮТСЯ ИЗ ПАКЕТА».
- `electron-builder` конфиг — в `apps/electron/package.json` (поле `build`): `asarUnpack: ["**/*.node"]`,
  `npmRebuild: false` (N-API не требует пересборки), web-дист через `extraResources`.
- **Windows NSIS-инсталлятор требует wine** (недоступен без sudo). Поэтому `win.target: ["zip"]` +
  `signAndEditExecutable: false`. На машине с wine или Windows можно вернуть `nsis`.
- **Linux: `.deb`** — `chrome-sandbox` получает setuid через postinst, песочница работает без флагов.
- Артефакты: `apps/electron/release/` → `*.deb` (Linux), `*-win.zip` (Windows).

### `.deb`: на Linux — как на Windows, через `make`; контейнер — если собираете с Windows

На Linux адрес сервера вшивается ровно так же, как в Windows-комплект:

```bash
make package-deb SERVER_URL=http://mail.enterprise.local:8123   # он же make package-linux
# результат: apps/electron/release/mailsense-electron_0.1.4_amd64.deb
```

`make package-linux` и `make package-deb` — **синонимы** (одна реализация): оба кладут `server.json`
рядом с бинарником (`/opt/MailSense/server.json`). Без `SERVER_URL` файла в пакете нет.

На **Windows** этот путь не работает — electron-builder требует `fpm` (Ruby):

```
⨯ cannot execute  cause=exec: "fpm": executable file not found in %PATH%
```

Причина не в проекте: electron-builder для `.deb` требует `fpm` (Ruby), а его под Windows нет.
Упаковка идёт **в Linux-контейнере** (`docker/Dockerfile.deb`), где ставится ruby+fpm и нативные
зависимости под Linux:

```bash
# из корня репозитория, только с доступным Docker
docker build --network=host -f docker/Dockerfile.deb --output type=local,dest=deb-out .
# результат: deb-out/mailsense-electron_0.1.4_amd64.deb
```

Что важно знать про этот путь:
- сборка идёт с нуля (`pnpm install` внутри Linux), поэтому нативные модули (`better-sqlite3`,
  `@napi-rs/canvas`) получаются именно под Linux — переносить `node_modules` с Windows нельзя;
- `--output type=local` копирует уже готовый `.deb` на хост (в образе-результате ничего лишнего);
- адрес сервера вшивается сборочным аргументом (файл `build-extra/server.json` уходит в пакет
  как `extraFiles`, то есть ложится рядом с бинарником — в `.deb` это `/opt/MailSense/server.json`):

  ```bash
  docker build --network=host --build-arg SERVER_URL=http://mail.enterprise.local:8123 \
    -f docker/Dockerfile.deb --output type=local,dest=deb-out .
  ```

  Без аргумента адреса в пакете нет — приложение спросит его при первом запуске. Тот же файл можно
  подготовить заранее вручную: `node apps/electron/scripts/make-server-json.mjs <url>`;
- если канал медленный, установка в контейнере уже идёт с поднятыми таймаутами pnpm
  (`ARG PNPM_INSTALL_FLAGS` в обоих Dockerfile), их можно переопределить сборочным аргументом.

## Что каким Dockerfile'ам нужно из сети

| Сборка | База | apt / зеркала Debian | npm |
|---|---|---|---|
| Серверный образ (`docker/Dockerfile`) | `node:22-bookworm-slim` | **не нужен** | да (`pnpm install`) |
| `.deb` в контейнере (`docker/Dockerfile.deb`) | `node:22-bookworm` | **нужен** (ruby+fpm) | да |

⚠️ **Серверный образ не ставит ничего через apt — и это осознанно.** В `node:22-bookworm-slim` нет
системного хранилища сертификатов (каталога `/etc/ssl/certs` вообще нет), но Node проверяет TLS
**своим встроенным** хранилищем — проверено на этом образе: 119 корневых сертификатов, HTTPS
к публичному хосту проходит без apt. Прежняя установка `ca-certificates` была лишней, а в сетях без
доступа к зеркалам Debian она роняла сборку целиком:

```
E: Package 'ca-certificates' has no installation candidate
```

Если целевая сеть закрыта, а собирать нужно: собирайте образ там, где есть npm-реестр, и переносите
файлом — `docker save mailsense:latest -o mailsense-image.tar` → на месте `docker load -i …`.

Сборка `.deb` в контейнере, наоборот, требует apt (ruby, ruby-dev, build-essential) и rubygems.
В закрытой сети используйте `make package-deb` на Linux-машине, где `fpm` уже есть.

## TLS и self-signed

`rejectUnauthorized` по умолчанию **false** — принимаем self-signed, как на проде MDaemon.
Смысл поля: `settings.rejectUnauthorized === true` включает строгий режим.

## Команды по пакетам

```bash
pnpm --filter @mailsense/core build        # tsup → dist (ESM, --dts)
pnpm --filter @mailsense/server build
pnpm --filter @mailsense/web build         # vite build
pnpm --filter @mailsense/web typecheck     # tsc --noEmit
pnpm --filter mailsense-electron build     # tsup: main.js (ESM) + preload.cjs
```
