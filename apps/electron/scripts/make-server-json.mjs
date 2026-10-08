#!/usr/bin/env node
/**
 * Готовит файл конфигурации предприятия для упаковки.
 *
 * Зачем: адрес сервера СЭД должен приезжать работнику уже в комплекте (решение Р21).
 * Приложение ищет server.json РЯДОМ с исполняемым файлом — это «адрес задан администратором»,
 * пользователь его не меняет. electron-builder копирует содержимое каталога build-extra
 * в каталог приложения (extraFiles), то есть файл ложится ровно рядом с .exe.
 *
 * Использование:
 *   node scripts/make-server-json.mjs http://mail.example.local:8123
 *   SERVER_URL=http://mail.example.local:8123 node scripts/make-server-json.mjs
 *   node scripts/make-server-json.mjs            # адрес не вшиваем, файл убираем
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "build-extra");
const outFile = path.join(outDir, "server.json");

const raw = (process.argv[2] ?? process.env.SERVER_URL ?? process.env.MAILSENSE_SERVER_URL ?? "").trim();

mkdirSync(outDir, { recursive: true });

if (!raw) {
  // Пустой файл опасен: приложение считает испорченный конфиг предприятия ОШИБКОЙ
  // («присутствие важнее содержимого») и не станет искать адрес дальше. Поэтому
  // если адрес не задан — файла в пакете быть не должно.
  rmSync(outFile, { force: true });
  console.log("server.json не вшиваем: адрес не задан (в пакете будет только автономный режим)");
  process.exit(0);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error("Адрес не разбирается как URL: " + raw);
  process.exit(1);
}
if (url.protocol !== "http:" && url.protocol !== "https:") {
  console.error("Адрес должен начинаться с http:// или https://: " + raw);
  process.exit(1);
}

const body = {
  serverUrl: url.origin,
  comment: "Адрес сервера документооборота. Файл добавлен при сборке комплекта; пользователь его не меняет."
};
writeFileSync(outFile, JSON.stringify(body, null, 2) + "\n", "utf8");
console.log("Вшит адрес сервера: " + url.origin + " → " + path.relative(process.cwd(), outFile));
