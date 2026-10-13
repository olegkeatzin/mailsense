#!/usr/bin/env node
/**
 * Проверка, что клиентский пакет не останется без нужных зависимостей.
 *
 * Зачем: в упакованное приложение попадают только зависимости apps/electron. Если код рабочей
 * области (core/docflow/server) тянет пакет, которого в этом списке нет, приложение падает
 * У ПОЛЬЗОВАТЕЛЯ при запуске:
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from ...driver.js
 * Ровно это и случилось: pg был у docflow, но не у apps/electron, и релизный zip ушёл без
 * драйвера PostgreSQL. Проверка запускается до упаковки и не даёт собрать такой пакет.
 *
 * ⚠️ Этого мало для полной уверенности: после упаковки обязательно запустите собранное
 * приложение (или тест загрузки зависимостей из пакета) — см. docs/build.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const root = path.resolve(appDir, "..", "..");

/** Пакеты рабочей области, код которых исполняется внутри клиента. */
const WORKSPACE_SOURCES = ["packages/core", "packages/docflow", "packages/server"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Все не-workspace зависимости, нужные клиенту во время работы. */
export function requiredRuntimeDeps() {
  const need = new Map();
  for (const rel of WORKSPACE_SOURCES) {
    const pkg = readJson(path.join(root, rel, "package.json"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith("@mailsense/")) continue;
      need.set(name, [...(need.get(name) ?? []), rel]);
    }
  }
  return need;
}

/** Чего не хватает в зависимостях apps/electron (то есть в пакет не попадёт). */
export function findMissingInManifest() {
  const deps = new Set(Object.keys(readJson(path.join(appDir, "package.json")).dependencies ?? {}));
  return [...requiredRuntimeDeps()]
    .filter(([name]) => !deps.has(name))
    .map(([name, who]) => ({ name, who }));
}

function main() {
  const missing = findMissingInManifest();
  if (missing.length) {
    console.error("УПАКОВКА БУДЕТ НЕПОЛНОЙ: этих зависимостей нет в apps/electron/package.json,");
    console.error("значит в пакет они не попадут, а приложение упадёт при запуске:");
    for (const m of missing) console.error("  " + m.name + "  (требует " + m.who.join(", ") + ")");
    process.exit(1);
  }
  console.log("Зависимости: все " + requiredRuntimeDeps().size + " объявлены в apps/electron — в пакет попадут");
}

// Только при прямом вызове: импорт из теста не должен завершать процесс.
if (process.argv[1] && import.meta.url === pathToFileURLSafe(process.argv[1])) main();

function pathToFileURLSafe(p) {
  return new URL("file:///" + path.resolve(p).replace(/\\/g, "/").replace(/^\//, "")).href;
}
