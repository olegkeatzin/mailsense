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
- `electron-builder` конфиг — в `apps/electron/package.json` (поле `build`): `asarUnpack: ["**/*.node"]`,
  `npmRebuild: false` (N-API не требует пересборки), web-дист через `extraResources`.
- **Windows NSIS-инсталлятор требует wine** (недоступен без sudo). Поэтому `win.target: ["zip"]` +
  `signAndEditExecutable: false`. На машине с wine или Windows можно вернуть `nsis`.
- **Linux: `.deb`** — `chrome-sandbox` получает setuid через postinst, песочница работает без флагов.
- Артефакты: `apps/electron/release/` → `*.deb` (Linux), `*-win.zip` (Windows).

### ⚠️ `.deb` на Windows не собирается — только в контейнере

`make package-linux` на Windows падает на упаковке:

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
