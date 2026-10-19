import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { closeDocflowDb, getDocflowDb, initDocflowDb } from "./db/index.js";
// Настройки каталога (ldap.*) — общая инфраструктура и живут в базе core (SQLite),
// поэтому в тестах нужно поднять и её. В приложении это делает initApp().
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { getSetting, setSetting } from "./settings.js";
import {
  assignRoles,
  authStatus,
  cleanupSessions,
  getUserPasswordHash,
  getUserRoles,
  hashPassword,
  isDocflowEnabled,
  listAudit,
  listRoles,
  listUsersWithRoles,
  login,
  logout,
  resolveToken,
  revokeSessions,
  setDocflowEnabled,
  setUserActive,
  verifyPassword
} from "./index.js";
import { getUserByLdapUid, insertUser, setUserRoles, updateUser } from "./repo.js";
import { buildAuthUser, hasPermission, permissionsOfRoles } from "./roles.js";
import type { AuthUser } from "./types.js";

/**
 * Адрес тестовой базы. Документооборот живёт в PostgreSQL, поэтому тесты без неё
 * не запускаются: поднимите сервер (docker compose up postgres) и задайте
 * DOCFLOW_TEST_DATABASE_URL.
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
let savedAdminLogins: string | undefined;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-docflow-"));
  initCoreDb(dir);
  try {
    await initDocflowDb(TEST_DB_URL);
  } catch (err) {
    throw new Error(
      "Не удалось подключиться к PostgreSQL для тестов (" + TEST_DB_URL + "): " + (err as Error).message +
        ". Поднимите базу и задайте DOCFLOW_TEST_DATABASE_URL."
    );
  }
  // Прогон должен быть повторяемым: чистим данные и настройки, роли остаются из миграции.
  // Без очистки settings состояние (например, docflow.enabled) переживает прогон.
  await getDocflowDb().execute(sql`TRUNCATE TABLE audit_log, sessions, user_roles, users, settings CASCADE`);
  // Роль администратора выдаётся только явно перечисленным логинам.
  savedAdminLogins = process.env.MAILSENSE_ADMIN_LOGINS;
  process.env.MAILSENSE_ADMIN_LOGINS = "ivanov";
});

afterAll(async () => {
  if (savedAdminLogins === undefined) delete process.env.MAILSENSE_ADMIN_LOGINS;
  else process.env.MAILSENSE_ADMIN_LOGINS = savedAdminLogins;
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Приводит число администраторов к n. */
let extraCounter = 0;
async function ensureAdminCount(n: number): Promise<void> {
  const admins = await listUsersWithRoles({ roleId: "admin", includeInactive: true });
  while (admins.length < n) {
    extraCounter++;
    const u = await insertUser({
      ldapUid: "admin-extra-" + extraCounter,
      email: "admin" + extraCounter + "@test.local",
      fullName: "Доп. администратор",
      source: "manual"
    });
    await setUserRoles(u.id, ["admin"]);
    admins.push({ ...u, roles: ["admin"] });
  }
  for (const extra of admins.slice(n)) {
    const rest = extra.roles.filter((r) => r !== "admin");
    await setUserRoles(extra.id, rest.length ? rest : ["executor"]);
  }
}

function actorOf(roleIds: string[]): AuthUser {
  return buildAuthUser({
    id: "actor-1",
    ldapUid: "actor",
    ldapDn: null,
    email: "actor@test.local",
    fullName: "Актор Акторович",
    department: "",
    position: "",
    managerDn: null,
    managerId: null,
    phone: "",
    source: "manual",
    isActive: true,
    blocked: false,
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roles: roleIds
  });
}

describe("роли и права", () => {
  test("миграция засеяла четыре встроенные роли", async () => {
    const ids = (await listRoles()).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["admin", "secretary", "manager", "executor"]));
  });

  test("аппарат не может менять текст резолюции, руководитель — журнал (ТЗ п. 7)", () => {
    const secretary = permissionsOfRoles(["secretary"]);
    const manager = permissionsOfRoles(["manager"]);

    expect(secretary).toContain("journal.register");
    expect(secretary).toContain("journal.edit");
    expect(secretary).not.toContain("resolution.edit");

    expect(manager).toContain("resolution.create");
    expect(manager).toContain("resolution.edit");
    expect(manager).toContain("journal.view");
    expect(manager).not.toContain("journal.edit");
    expect(manager).not.toContain("journal.register");
  });

  test("совмещение ролей объединяет права", () => {
    const both = permissionsOfRoles(["secretary", "manager"]);
    expect(both).toContain("journal.register");
    expect(both).toContain("resolution.create");
  });

  test("исполнитель не получает административных прав", () => {
    expect(hasPermission(actorOf(["executor"]), "users.manage")).toBe(false);
    expect(hasPermission(actorOf(["admin"]), "users.manage")).toBe(true);
  });
});

describe("пароли локальных учёток", () => {
  test("scrypt-хэш проверяется и не совпадает с открытым паролем", () => {
    const hash = hashPassword("Пароль123!");
    expect(hash).not.toContain("Пароль123!");
    expect(verifyPassword("Пароль123!", hash)).toBe(true);
    expect(verifyPassword("другой", hash)).toBe(false);
    expect(verifyPassword("Пароль123!", null)).toBe(false);
  });
});

describe("вход и сессии", () => {
  test("статус по умолчанию: документооборот выключен, справочник пуст", async () => {
    const s = await authStatus();
    expect(s.docflowEnabled).toBe(false);
    expect(s.needsBootstrap).toBe(true);
  });

  test("без MAILSENSE_ADMIN_LOGINS администратор автоматически не назначается", async () => {
    const saved = process.env.MAILSENSE_ADMIN_LOGINS;
    delete process.env.MAILSENSE_ADMIN_LOGINS;
    try {
      const u = await insertUser({
        ldapUid: "noauto",
        email: "noauto@test.local",
        fullName: "Без авто-прав",
        source: "local",
        passwordHash: hashPassword("NoAuto123!")
      });
      await setSetting("auth.localLoginEnabled", "true");

      const res = await login({ login: "noauto", password: "NoAuto123!" });
      expect(res.user.id).toBe(u.id);
      expect(res.user.roles).toEqual([]);
      expect(res.user.permissions).toEqual([]);
      expect((await resolveToken(res.token))?.id).toBe(u.id);
      expect((await authStatus()).adminConfigured).toBe(false);
      expect((await authStatus()).hasAdmin).toBe(false);
    } finally {
      process.env.MAILSENSE_ADMIN_LOGINS = saved ?? "ivanov";
    }
  });

  test("логин из MAILSENSE_ADMIN_LOGINS получает администратора при входе", async () => {
    await setDocflowEnabled(true);
    expect(await isDocflowEnabled()).toBe(true);

    const u = await insertUser({
      ldapUid: "ivanov",
      email: "ivanov@test.local",
      fullName: "Иван Иванов",
      source: "local",
      passwordHash: hashPassword("Secret123!")
    });
    await setSetting("auth.localLoginEnabled", "true");

    const res = await login({ login: "ivanov", password: "Secret123!" });
    expect(res.user.id).toBe(u.id);
    expect(res.user.roles).toContain("admin");
    expect(res.user.permissions).toContain("users.manage");
    expect(res.token).toBeTruthy();
    expect((await authStatus()).adminConfigured).toBe(true);
    expect((await authStatus()).hasAdmin).toBe(true);
    expect((await resolveToken(res.token))?.id).toBe(u.id);
    expect(await getUserPasswordHash(u.id)).toBeTruthy();
  });

  test("неверный пароль не пускает", async () => {
    await expect(login({ login: "ivanov", password: "неверный" })).rejects.toThrow(/Неверный логин или пароль/);
  });

  test("выход убивает сессию", async () => {
    const res = await login({ login: "ivanov", password: "Secret123!" });
    expect(await resolveToken(res.token)).not.toBeNull();
    await logout(res.token);
    expect(await resolveToken(res.token)).toBeNull();
  });

  test("протухшая сессия не разрешается", async () => {
    const res = await login({ login: "ivanov", password: "Secret123!" });
    const { createHash } = await import("node:crypto");
    const { docflowSchema } = await import("./db/schema.js");
    const { eq } = await import("drizzle-orm");
    const id = createHash("sha256").update(res.token).digest("hex");
    await getDocflowDb()
      .update(docflowSchema.sessions)
      .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(docflowSchema.sessions.id, id));
    expect(await resolveToken(res.token)).toBeNull();
    expect(await cleanupSessions()).toBe(0); // протухшая уже удалена при проверке
  });

  test("блокировка пользователя немедленно рвёт сессии и запрещает вход", async () => {
    await ensureAdminCount(2);
    const res = await login({ login: "ivanov", password: "Secret123!" });
    const admin = actorOf(["admin"]);

    await setUserActive(res.user.id, false, admin);
    expect(await resolveToken(res.token)).toBeNull();
    await expect(login({ login: "ivanov", password: "Secret123!" })).rejects.toThrow(/заблокирована/);

    await setUserActive(res.user.id, true, admin);
    const again = await login({ login: "ivanov", password: "Secret123!" });
    expect(again.user.id).toBe(res.user.id);
  });
});

describe("управление ролями", () => {
  test("назначение ролей меняет права сразу и НЕ выкидывает из системы", async () => {
    await ensureAdminCount(2);
    const res = await login({ login: "ivanov", password: "Secret123!" });
    const admin = actorOf(["admin"]);

    const updated = await assignRoles(res.user.id, ["executor"], admin);
    expect(updated.roles).toEqual(["executor"]);
    // ⚠️ Заказчик: выдав роль, администратор выкидывал человека из приложения («новое
    // появляется только после перезапуска»). Права и так перечитываются на каждом запросе,
    // поэтому сессия остаётся живой, а набор прав меняется сразу.
    const sameSession = await resolveToken(res.token);
    expect(sameSession).not.toBeNull();
    expect(sameSession?.roles).toEqual(["executor"]);
    expect(sameSession?.permissions ?? []).not.toContain("users.manage");

    await assignRoles(res.user.id, ["admin"], admin);
    expect((await resolveToken(res.token))?.roles).toEqual(["admin"]);
  });

  test("нельзя снять роль у последнего администратора", async () => {
    await ensureAdminCount(1);
    const admin = actorOf(["admin"]);
    const onlyAdmin = (await listUsersWithRoles({ roleId: "admin", includeInactive: true }))[0];
    await expect(assignRoles(onlyAdmin.id, ["executor"], admin)).rejects.toThrow(/хотя бы один администратор/);
    await expect(setUserActive(onlyAdmin.id, false, admin)).rejects.toThrow(/хотя бы один администратор/);
  });

  test("нельзя отключить самого себя", async () => {
    await ensureAdminCount(2);
    const me = (await listUsersWithRoles({ roleId: "admin", includeInactive: true }))[0];
    const self = buildAuthUser({ ...me, roles: me.roles });
    await expect(setUserActive(me.id, false, self)).rejects.toThrow(/собственную учётную запись/);
  });

  test("неизвестная роль отклоняется", async () => {
    const admin = actorOf(["admin"]);
    const u = (await listUsersWithRoles({ includeInactive: true }))[0];
    await expect(assignRoles(u.id, ["суперроль"], admin)).rejects.toThrow(/Неизвестные роли/);
  });

  test("revokeSessions возвращает число разорванных сессий", async () => {
    const res = await login({ login: "ivanov", password: "Secret123!" });
    expect(await revokeSessions(res.user.id)).toBeGreaterThanOrEqual(1);
  });
});

describe("аудит", () => {
  test("вход и смена ролей попадают в журнал аудита", async () => {
    await ensureAdminCount(2);
    // предыдущие тесты могли понизить роль — возвращаем админа для чистой проверки
    await setUserRoles((await getUserByLdapUid("ivanov"))!.id, ["admin"]);
    const before = (await listAudit({ limit: 1000 })).length;
    const res = await login({ login: "ivanov", password: "Secret123!" });
    await assignRoles(res.user.id, ["admin", "secretary"], actorOf(["admin"]));

    const entries = await listAudit({ limit: 1000 });
    expect(entries.length).toBeGreaterThan(before);
    expect(entries.some((e) => e.action === "login")).toBe(true);
    expect(entries.some((e) => e.action === "user.roles")).toBe(true);

    const roleEntry = entries.find((e) => e.action === "user.roles")!;
    expect(roleEntry.oldValue).toContain("admin");
    expect(roleEntry.newValue).toContain("secretary");
  });

  test("аудит фильтруется по сущности", async () => {
    await ensureAdminCount(1);
    const u = (await getUserByLdapUid("ivanov"))!;
    const entries = await listAudit({ entityType: "user", entityId: u.id, limit: 50 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.entityId === u.id)).toBe(true);
  });
});

describe("состояние документооборота", () => {
  test("переключатель docflow.enabled отражается в статусе", async () => {
    await setDocflowEnabled(false);
    expect((await authStatus()).docflowEnabled).toBe(false);
    expect(await getSetting("docflow.enabled")).toBe("false");
    await setDocflowEnabled(true);
    expect((await authStatus()).docflowEnabled).toBe(true);
    expect((await authStatus()).needsBootstrap).toBe(false);
  });
});

// Идёт последним: создаёт пользователей и ломает проверки про пустой справочник.
describe("поиск пользователя по логину", () => {
  // Регрессия: регистронезависимый поиск по кириллическому логину AD.
  test("кириллический логин находится при повторном входе и в любом регистре", async () => {
    const u = await insertUser({
      ldapUid: "Иванов_ИИ",
      email: "ivanov_ii@test.local",
      fullName: "Иван Иванов",
      source: "ldap"
    });

    expect((await getUserByLdapUid("Иванов_ИИ"))?.id).toBe(u.id);
    expect((await getUserByLdapUid("иванов_ии"))?.id).toBe(u.id);
    expect((await getUserByLdapUid("ИВАНОВ_ИИ"))?.id).toBe(u.id);
    expect(await getUserByLdapUid("Несуществующий_Логин")).toBeNull();
  });

  test("латинский логин остаётся регистронезависимым", async () => {
    const u = await insertUser({ ldapUid: "Petrov", email: "petrov@test.local", source: "ldap" });
    expect((await getUserByLdapUid("petrov"))?.id).toBe(u.id);
    expect((await getUserByLdapUid("PETROV"))?.id).toBe(u.id);
  });

  test("смена логина обновляет ключ поиска", async () => {
    const u = await insertUser({ ldapUid: "old_login", email: "old@test.local", source: "ldap" });
    await updateUser(u.id, { ldapUid: "Новый_Логин" });
    expect(await getUserByLdapUid("old_login")).toBeNull();
    expect((await getUserByLdapUid("новый_логин"))?.id).toBe(u.id);
  });
});
