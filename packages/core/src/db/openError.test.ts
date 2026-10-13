import path from "node:path";
import { explainDbOpenError } from "./index.js";

/**
 * Отказ открыть базу должен объяснять себя сам.
 *
 * Найдено на развёртывании: Docker создал папку данных от root (её не было до первого запуска),
 * а приложение в контейнере работает от пользователя node (UID 1000). В журнале был голый
 * «SqliteError: unable to open database file» — по нему нельзя понять, что делать.
 */
describe("понятная ошибка открытия базы", () => {
  test("SQLITE_CANTOPEN называет путь, причину и команду", () => {
    const err = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    const out = explainDbOpenError(err, "/data", "mailsense.sqlite");

    // Путь собирается через path.join, поэтому в ожидании он тоже платформенный:
    // проверяем и разделитель, и имя файла, а не жёстко «/data/…».
    expect(out.message).toContain(path.join("/data", "mailsense.sqlite"));
    expect(out.message).toContain("node (UID 1000)");
    expect(out.message).toContain("chown -R 1000:1000 /data");
    expect(out.message).toContain("mkdir -p data pgdata");
  });

  test("отказ создать сам каталог объясняется так же", () => {
    const err = Object.assign(new Error("EACCES: permission denied, mkdir '/data'"), { code: "EACCES" });
    const out = explainDbOpenError(err, "/data", "mailsense.sqlite");

    expect(out.message).toContain("недоступен для записи");
    expect(out.message).toContain(path.join("/data", "mailsense.sqlite"));
  });

  test("другие ошибки не подменяются: причина остаётся исходной", () => {
    const err = new Error("file is not a database");

    expect(explainDbOpenError(err, "/data", "mailsense.sqlite")).toBe(err);
  });
});
