import fs from "node:fs";
import path from "node:path";

/**
 * Полнота клиентского пакета.
 *
 * Найдено на приёмке: собранный zip для Windows падал у пользователя при запуске
 * («Cannot find package 'pg' imported from ... driver.js»). Причина: pg нужен packages/docflow,
 * но не был объявлен у apps/electron, а в пакет попадают только его зависимости. Здесь держим
 * инвариант: всё, что требует рабочая область во время работы, объявлено у клиента.
 *
 * Правило, которое этот тест защищает: новая зависимость core/docflow/server — это ещё и
 * зависимость apps/electron (или она сознательно переведена в бандл).
 */
describe("полнота клиентского пакета", () => {
  const root = path.resolve(process.cwd(), "..", "..");
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

  test("все рантайм-зависимости рабочей области объявлены у apps/electron", () => {
    const electron = new Set(Object.keys(read("apps/electron/package.json").dependencies ?? {}));
    const missing: string[] = [];
    for (const pkg of ["packages/core", "packages/docflow", "packages/server"]) {
      for (const name of Object.keys(read(pkg + "/package.json").dependencies ?? {})) {
        if (name.startsWith("@mailsense/")) continue;
        if (!electron.has(name)) missing.push(name + " (нужен " + pkg + ")");
      }
    }
    expect(missing).toEqual([]);
  });
});
