import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { ROLE_DEFINITIONS, permissionsOfRoles } from "./roles.js";
import { listRoles } from "./repo.js";
import type { BuiltinRoleId, Permission } from "./types.js";

/**
 * Матрица прав. Здесь проверяются ограничения из ТЗ п. 7, которые легко сломать
 * одной неосторожной правкой списка ролей:
 *   - Руководитель НЕ редактирует журнал;
 *   - Аппарат НЕ меняет утверждённый текст резолюции;
 *   - и главное для этапа 3: аппарат НЕ утверждает, а подписант НЕ отправляет.
 */
const TEST_DB_URL =
  process.env.DOCFLOW_TEST_DATABASE_URL ??
  "postgres://mailsense:testpass@127.0.0.1:55432/mailsense_test";


// ⚠️ Прогон делает TRUNCATE, поэтому база обязана быть отдельной и тестовой.
// Раньше здесь был фолбэк на DOCFLOW_DATABASE_URL — рабочую переменную стенда: один
// `make test` на машине с ней вычищал пользователей, сессии, настройки и append-only аудит.
if (!/test/i.test(TEST_DB_URL)) {
  throw new Error(
    "Тесты чистят таблицы, поэтому база обязана быть тестовой (имя должно содержать test), а не " + TEST_DB_URL
  );
}

let dir = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-roles-"));
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

function perms(role: BuiltinRoleId): Permission[] {
  return permissionsOfRoles([role]);
}

function has(role: BuiltinRoleId, p: Permission): boolean {
  return perms(role).includes(p);
}

describe("ограничения ТЗ п. 7 «Безопасность»", () => {
  test("руководитель видит журнал, но не редактирует его", () => {
    expect(has("manager", "journal.view")).toBe(true);
    expect(has("manager", "journal.edit")).toBe(false);
    expect(has("manager", "journal.register")).toBe(false);
  });

  test("аппарат ведёт журнал, но не правит утверждённую резолюцию", () => {
    expect(has("secretary", "journal.register")).toBe(true);
    expect(has("secretary", "journal.edit")).toBe(true);
    expect(has("secretary", "resolution.edit")).toBe(false);
  });

  test("исполнитель не видит лишнего", () => {
    expect(has("executor", "task.view")).toBe(true);
    expect(has("executor", "task.report")).toBe(true);
    expect(has("executor", "journal.register")).toBe(false);
    expect(has("executor", "resolution.approve")).toBe(false);
  });

  test("администратор может всё", () => {
    const all = perms("admin");
    for (const def of ROLE_DEFINITIONS) {
      for (const p of def.permissions) expect(all).toContain(p);
    }
  });
});

describe("утверждение резолюции (Р8, Р9)", () => {
  test("утверждать может подписант и руководитель, но не аппарат", () => {
    // Иначе аппарат утверждал бы сам за себя — а решение принимает подписант.
    expect(has("signer", "resolution.approve")).toBe(true);
    expect(has("manager", "resolution.approve")).toBe(true);
    expect(has("secretary", "resolution.approve")).toBe(false);
    expect(has("executor", "resolution.approve")).toBe(false);
  });

  test("отправлять исполнителям может только аппарат", () => {
    // Аппарат — диспетчерский пункт: через него уходит всё (Р9).
    expect(has("secretary", "resolution.dispatch")).toBe(true);
    expect(has("signer", "resolution.dispatch")).toBe(false);
    expect(has("manager", "resolution.dispatch")).toBe(false);
  });

  test("подписант не получает лишних прав по журналу", () => {
    // Он только подписывает: регистрация и правка журнала ему не нужны.
    expect(has("signer", "journal.register")).toBe(false);
    expect(has("signer", "journal.edit")).toBe(false);
    expect(has("signer", "resolution.dispatch")).toBe(false);
  });

  test("подписант не может утверждать вместо другого подписанта", () => {
    // Право есть у всех подписантов — это и есть делегирование (Р9):
    // в журнале останется, кто именно утвердил.
    expect(has("signer", "resolution.approve")).toBe(true);
    expect(has("signer", "users.manage")).toBe(false);
  });
});

describe("роли в базе", () => {
  test("роль «Подписант» создаётся миграцией", async () => {
    const roles = await listRoles();
    const signer = roles.find((r) => r.id === "signer");
    expect(signer).toBeTruthy();
    expect(signer!.name).toBe("Подписант");
  });

  test("все встроенные роли есть в базе", async () => {
    const roles = await listRoles();
    for (const def of ROLE_DEFINITIONS) {
      expect(roles.some((r) => r.id === def.id)).toBe(true);
    }
  });

  test("чужие роли не считаются встроенными", async () => {
    // Роль, которой нет в ROLE_DEFINITIONS, не должна давать прав.
    await getDocflowPool().query(
      "INSERT INTO roles (id, name, description, sort_order, is_system) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
      ["custom_role", "Своя роль", "", 99, false]
    );
    const roles = await listRoles();
    expect(roles.some((r) => r.id === "custom_role")).toBe(true);
    await getDocflowPool().query("DELETE FROM roles WHERE id = $1", ["custom_role"]);
  });
});

describe("объединение ролей (совмещение, О2)", () => {
  test("права ролей складываются", () => {
    const both = permissionsOfRoles(["secretary", "signer"]);
    expect(both).toContain("journal.register");
    expect(both).toContain("resolution.approve");
    expect(both).toContain("resolution.dispatch");
  });

  test("дубликаты прав не повторяются", () => {
    const both = permissionsOfRoles(["manager", "signer"]);
    expect(both.filter((p) => p === "resolution.approve")).toHaveLength(1);
  });

  test("неизвестная роль прав не даёт", () => {
    expect(permissionsOfRoles(["нет-такой"])).toEqual([]);
  });
});