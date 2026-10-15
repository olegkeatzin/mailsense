import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { getUserRoles, insertUser, setUserRoles } from "./repo.js";
import { BUILTIN_ROLES, permissionsOfRoles } from "./roles.js";
import {
  RoleInputError,
  createRole,
  deleteRole,
  installRoleStore,
  listRolesFromDb,
  updateRole
} from "./roleAdmin.js";
import type { Actor } from "./journal.js";

/**
 * Конструктор ролей: администратор заводит роли сам и расставляет галочки прав.
 *
 * Проверяем то, что легко сломать: права роли применяются СРАЗУ (без перезапуска),
 * «Администратора» нельзя разоружить, назначенную роль нельзя удалить, а засев стартовых
 * прав не перетирает осознанное «прав нет».
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ?? "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";

if (!/test/i.test(TEST_DB_URL)) {
  throw new Error("Тесты чистят таблицы: база обязана быть тестовой, а не " + TEST_DB_URL);
}

const actor: Actor = { id: "u-admin", name: "Администратор" };
let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-role-admin-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
  await installRoleStore();
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

describe("конструктор ролей", () => {
  test("роль создаётся и сразу даёт свои права", async () => {
    const role = await createRole(
      { name: "Делопроизводитель", description: "Своя роль", permissions: ["journal.view", "journal.register"] },
      actor
    );

    expect(role.permissions).toEqual(["journal.view", "journal.register"]);
    expect((await listRolesFromDb()).some((r) => r.id === role.id)).toBe(true);
    // Права видны сразу: реестр перечитан после создания, перезапуск не нужен.
    expect(permissionsOfRoles([role.id])).toEqual(["journal.view", "journal.register"]);

    await deleteRole(role.id, actor);
  });

  test("незнакомое право — отказ, роль не создаётся", async () => {
    await expect(createRole({ name: "Кривая", permissions: ["journal.view", "нет-такого"] }, actor)).rejects.toThrow(
      RoleInputError
    );
    expect((await listRolesFromDb()).some((r) => r.name === "Кривая")).toBe(false);
  });

  test("без названия роль не создаётся", async () => {
    await expect(createRole({ permissions: [] }, actor)).rejects.toThrow(/название/i);
  });

  test("права меняются и вступают в силу сразу", async () => {
    const role = await createRole({ name: "Проверка прав", permissions: ["task.view"] }, actor);

    await updateRole(role.id, { permissions: ["task.view", "task.report"] }, actor);

    expect(permissionsOfRoles([role.id]).sort()).toEqual(["task.report", "task.view"]);
    const updated = (await listRolesFromDb()).find((r) => r.id === role.id)!;
    expect(updated.permissions.sort()).toEqual(["task.report", "task.view"]);

    await deleteRole(role.id, actor);
  });

  test("роль «Администратор» изменить нельзя: иначе её нечем вернуть", async () => {
    await expect(updateRole("admin", { permissions: ["task.view"] }, actor)).rejects.toThrow(/Администратор/);
    expect(permissionsOfRoles(["admin"]).length).toBeGreaterThan(10);
  });

  test("системную роль удалить нельзя", async () => {
    await expect(deleteRole("secretary", actor)).rejects.toThrow(/Системную/);
  });

  test("назначенную роль удалять нельзя: сначала снять у работников", async () => {
    const role = await createRole({ name: "Назначенная", permissions: ["task.view"] }, actor);
    const user = await insertUser({
      ldapUid: "role-check",
      email: "role-check@stand.test",
      fullName: "Проверка роли",
      source: "manual"
    });
    await setUserRoles(user.id, [role.id], "test");

    await expect(deleteRole(role.id, actor)).rejects.toThrow(/назначена/i);
    expect(await getUserRoles(user.id)).toEqual([role.id]);

    await setUserRoles(user.id, [], "test");
    await deleteRole(role.id, actor);
    expect((await listRolesFromDb()).some((r) => r.id === role.id)).toBe(false);
  });

  test("засев: NULL получает стартовые права, а '[]' — осознанное «прав нет»", async () => {
    // NULL — состояние «роль заведена до конструктора ролей».
    await getDocflowPool().query("UPDATE roles SET permissions = NULL WHERE id = $1", ["executor"]);
    await installRoleStore();
    expect((await listRolesFromDb()).find((r) => r.id === "executor")!.permissions.length).toBeGreaterThan(0);

    // Пустой список — решение администратора, повторный засев его не трогает.
    await getDocflowPool().query("UPDATE roles SET permissions = '[]' WHERE id = $1", ["executor"]);
    await installRoleStore();
    expect((await listRolesFromDb()).find((r) => r.id === "executor")!.permissions).toEqual([]);

    // Возвращаем стартовые права: дальше тесты рассчитывают на штатную матрицу.
    await updateRole("executor", { permissions: BUILTIN_ROLES.find((r) => r.id === "executor")!.permissions }, actor);
    expect(permissionsOfRoles(["executor"]).length).toBeGreaterThan(0);
  });
});
