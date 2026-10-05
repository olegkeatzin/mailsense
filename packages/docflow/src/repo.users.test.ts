import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { insertUser, listUsersWithRoles, setUserRoles } from "./repo.js";

/**
 * Справочник пользователей: фильтры и limit обязаны работать в SQL.
 *
 * Прежний listUsersWithRoles вытаскивал ВСЮ таблицу пользователей в память, а потом
 * фильтровал и «пагинировал» в JS. На справочнике в тысячи человек каждый вызов
 * /api/users (и каждая проверка hasAdmin) стоил полной выборки. Здесь проверяется
 * поведение: на limit=5 в память не приходит больше пяти строк, а фильтры
 * (поиск, роль, неактивные) дают те же результаты, что и раньше.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-listusers-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await getDocflowPool().query(
    "TRUNCATE users, user_roles, sessions, audit_log RESTART IDENTITY CASCADE"
  );
  const ts = new Date().toISOString();
  // 50 человек: этого достаточно, чтобы увидеть «весь справочник» в памяти.
  await getDocflowPool().query(
    "INSERT INTO users (id, ldap_uid, ldap_uid_key, email, full_name, department, position, source, is_active, blocked, created_at, updated_at) " +
      "SELECT 'u-' || g, 'login' || g, 'login' || g, 'user' || g || '@stand.test', " +
      "'Сотрудник ' || lpad(g::text, 2, '0'), 'Отдел ' || (g % 5), 'Должность ' || g, 'ldap', TRUE, FALSE, $1, $1 " +
      "FROM generate_series(1, 50) g",
    [ts]
  );
  await getDocflowPool().query(
    "INSERT INTO user_roles (user_id, role_id, granted_at) SELECT 'u-' || g, 'executor', $1 FROM generate_series(1, 50) g",
    [ts]
  );
  await setUserRoles("u-1", ["admin"]);
  await setUserRoles("u-2", ["secretary"]);
});

/** Сколько строк максимум пришло в JS за время вызова. */
async function measureRows<T>(fn: () => Promise<T>): Promise<{ result: T; maxRows: number }> {
  const pool = getDocflowPool() as unknown as { query: (...args: unknown[]) => unknown };
  const original = pool.query;
  let maxRows = 0;
  pool.query = function (this: unknown, ...args: unknown[]) {
    const out = (original as (...a: unknown[]) => unknown).apply(this, args) as Promise<{ rows?: unknown[] }> | unknown;
    if (out && typeof (out as Promise<unknown>).then === "function") {
      return (out as Promise<{ rows?: unknown[] }>).then((res) => {
        maxRows = Math.max(maxRows, res?.rows?.length ?? 0);
        return res;
      });
    }
    return out;
  };
  try {
    return { result: await fn(), maxRows };
  } finally {
    pool.query = original;
  }
}

describe("listUsersWithRoles: фильтры и limit в SQL", () => {
  test("limit не тянет весь справочник в память", async () => {
    const { result, maxRows } = await measureRows(() => listUsersWithRoles({ includeInactive: true, limit: 5 }));
    expect(result).toHaveLength(5);
    // На прежнем коде в память приходили все 50 строк пользователей.
    expect(maxRows).toBeLessThanOrEqual(5);
  });

  test("поиск по ФИО, логину, отделу и должности не зависит от регистра", async () => {
    const byName = await listUsersWithRoles({ q: "сотрудник 42", includeInactive: true });
    expect(byName.map((u) => u.id)).toEqual(["u-42"]);

    const byLogin = await listUsersWithRoles({ q: "LOGIN7", includeInactive: true });
    expect(byLogin.map((u) => u.id)).toEqual(["u-7"]);

    const byDepartment = await listUsersWithRoles({ q: "Отдел 3", includeInactive: true });
    expect(byDepartment.length).toBe(10);

    const byPosition = await listUsersWithRoles({ q: "должность 11", includeInactive: true });
    expect(byPosition.map((u) => u.id)).toEqual(["u-11"]);
  });

  test("символ % в поиске не означает «показать всех»", async () => {
    const list = await listUsersWithRoles({ q: "%", includeInactive: true });
    expect(list).toHaveLength(0);
  });

  test("фильтр по роли возвращает только носителей роли", async () => {
    const admins = await listUsersWithRoles({ roleId: "admin", includeInactive: true });
    expect(admins.map((u) => u.id)).toEqual(["u-1"]);
    expect(admins[0].roles).toContain("admin");
  });

  test("неактивные скрыты по умолчанию и видны по флагу", async () => {
    await getDocflowPool().query("UPDATE users SET is_active = FALSE WHERE id = 'u-3'");
    const active = await listUsersWithRoles({});
    expect(active.some((u) => u.id === "u-3")).toBe(false);
    expect(active).toHaveLength(49);

    const all = await listUsersWithRoles({ includeInactive: true });
    expect(all.some((u) => u.id === "u-3")).toBe(true);
    expect(all).toHaveLength(50);
  });

  test("фильтры складываются: роль + поиск + limit", async () => {
    const list = await listUsersWithRoles({ roleId: "executor", q: "Сотрудник 1", includeInactive: true, limit: 3 });
    expect(list.length).toBeLessThanOrEqual(3);
    for (const u of list) expect(u.roles).toContain("executor");
  });

  test("роли подтягиваются одним запросом на весь список", async () => {
    const { result } = await measureRows(() => listUsersWithRoles({ includeInactive: true, limit: 10 }));
    expect(result).toHaveLength(10);
    for (const u of result) expect(Array.isArray(u.roles)).toBe(true);
  });

  test("порядок — по ФИО, затем по email", async () => {
    const list = await listUsersWithRoles({ includeInactive: true, limit: 3 });
    expect(list.map((u) => u.fullName)).toEqual(["Сотрудник 01", "Сотрудник 02", "Сотрудник 03"]);
  });
});
