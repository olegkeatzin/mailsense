import fs from "node:fs";
import path from "node:path";

/**
 * Документированная переменная обязана доходить до контейнера.
 *
 * ⚠️ Найдено на практике: `docker/.env.example` описывал `MAILSENSE_MAIL_DEFAULTS` и
 * `MAILSENSE_LDAP_UPN_SUFFIX`, а `docker-compose.yml` их НЕ пробрасывал — в Docker переменные
 * молча ничего не делали (умолчания почты не подставлялись, вход коротким логином не работал),
 * и человек искал причину в интерфейсе. Тест держит эти два файла синхронными.
 */
const root = path.resolve(process.cwd(), "..", "..");
const example = fs.readFileSync(path.join(root, "docker", ".env.example"), "utf8");
const compose = fs.readFileSync(path.join(root, "docker", "docker-compose.yml"), "utf8");

const exampleVars = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
const composeRefs = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));

describe("окружение контейнера", () => {
  test("в примере вообще есть переменные (файл не переписали в никуда)", () => {
    expect(exampleVars.length).toBeGreaterThan(10);
  });

  test("каждая переменная из .env.example доходит до контейнера", () => {
    const missing = exampleVars.filter((name) => !composeRefs.has(name));
    // Подсказка при провале: добавь переменную в docker-compose.yml или убери из примера.
    expect(missing).toEqual([]);
  });

  test("переменные в примере не дублируются — иначе путаница, какая главнее", () => {
    const duplicates = exampleVars.filter((name, i) => exampleVars.indexOf(name) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });
});
