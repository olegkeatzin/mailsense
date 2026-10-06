import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { buildAuthUser } from "./roles.js";
import { hasAdmin } from "./auth.js";
import { assignRoles, setUserActive } from "./users.js";
import {
  ADMIN_CHANGES_LOCK_KEY,
  countActingAdmins,
  deleteUser,
  getSession,
  getUser,
  getUserRoles,
  insertSession,
  insertUser,
  listAudit,
  listUsersWithRoles,
  setUserRoles,
  updateUser
} from "./repo.js";
import { authStatus } from "./auth.js";
import type { AuthUser, UserWithRoles } from "./types.js";

/**
 * «В системе должен остаться хотя бы один администратор» — проверка, которая
 * обязана переживать гонку, а не только последовательный вызов.
 *
 * Прежний код читал счёт администраторов ВНЕ транзакции изменения. Два одновременных
 * снятия прав с двух последних администраторов проходили ОБЕ проверки, и система
 * оставалась без администратора: выдать права становилось некому, лечилось только
 * правкой базы руками. Здесь гонка воспроизводится по-настоящему: оба вызова
 * стартуют в одном тике (Promise.allSettled), а не идут друг за другом.
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
let seq = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-admin-race-"));
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
  await getDocflowPool().query("TRUNCATE users, user_roles, sessions, audit_log RESTART IDENTITY CASCADE");
});

function actorOf(roleIds: string[]): AuthUser {
  const ts = new Date().toISOString();
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
    createdAt: ts,
    updatedAt: ts,
    roles: roleIds
  });
}

/**
 * Администратор заводится прямо в базе: тест про права, а не про вход.
 * isActive = false — «уволен в каталоге», blocked — ручная блокировка администратором.
 */
async function createAdmin(opts: { isActive?: boolean; blocked?: boolean } = {}): Promise<UserWithRoles> {
  seq++;
  const u = await insertUser({
    ldapUid: "race-admin-" + seq,
    email: "race-admin-" + seq + "@test.local",
    fullName: "Администратор " + String(seq).padStart(2, "0"),
    source: "manual",
    isActive: opts.isActive ?? true
  });
  // insertUser всегда создаёт незаблокированную учётку — блокируем отдельно.
  if (opts.blocked) await updateUser(u.id, { blocked: true });
  await setUserRoles(u.id, ["admin"]);
  return { ...u, roles: ["admin"], blocked: opts.blocked ?? false };
}

/**
 * Администраторы, которые реально могут войти: роль admin, учётка действующая
 * (не уволена в каталоге) и не заблокирована вручную. Ровно это условие проверяет
 * вход, и ровно его обязан держать инвариант «хотя бы один администратор».
 */
async function adminsWhoCanLogin(): Promise<string[]> {
  const list = await listUsersWithRoles({ roleId: "admin", includeInactive: true });
  return list.filter((u) => u.isActive && !u.blocked).map((u) => u.id);
}

/** Тексты отказов — чтобы проверить, что отклонён запрос именно по правилу, а не случайно. */
function rejectionText(results: PromiseSettledResult<unknown>[]): string {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason))
    .join("; ");
}

function fulfilledCount(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((r) => r.status === "fulfilled").length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("гонка за последнего администратора", () => {
  test("два параллельных снятия прав: проходит ровно одно, администратор остаётся", async () => {
    const [a, b] = await Promise.all([createAdmin(), createAdmin()]);
    expect(await adminsWhoCanLogin()).toHaveLength(2);
    const actor = actorOf(["admin"]);

    // Оба вызова стартуют в одном тике — это и есть гонка. Прежний код пропускал оба.
    const results = await Promise.allSettled([
      assignRoles(a.id, ["executor"], actor),
      assignRoles(b.id, ["executor"], actor)
    ]);

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectionText(results)).toMatch(/хотя бы один администратор/);

    // Главное: система не осталась без администратора.
    expect(await adminsWhoCanLogin()).toHaveLength(1);

    // Отклонённый запрос откатился целиком: роль на месте, следа аудита нет,
    // администратором остался именно он.
    const loser = results[0].status === "rejected" ? a : b;
    const winner = results[0].status === "rejected" ? b : a;
    expect(await adminsWhoCanLogin()).toEqual([loser.id]);
    expect(await getUserRoles(loser.id)).toEqual(["admin"]);
    expect(await getUserRoles(winner.id)).toEqual(["executor"]);
    const audit = await listAudit({ action: "user.roles", limit: 100 });
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(winner.id);
  });

  test("два параллельных отключения учётки: проходит ровно одно, администратор остаётся", async () => {
    const [a, b] = await Promise.all([createAdmin(), createAdmin()]);
    const actor = actorOf(["admin"]);

    const results = await Promise.allSettled([
      setUserActive(a.id, false, actor),
      setUserActive(b.id, false, actor)
    ]);

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectionText(results)).toMatch(/хотя бы один администратор/);
    expect(await adminsWhoCanLogin()).toHaveLength(1);

    // Отклонение откатило блокировку: учётка снова активна, следа в аудите нет.
    const loser = results[0].status === "rejected" ? a : b;
    expect((await getUser(loser.id))!.blocked).toBe(false);
    expect(await listAudit({ action: "user.block", limit: 100 })).toHaveLength(1);
  });

  test("снятие прав и блокировка одновременно: проходит ровно одно", async () => {
    const [a, b] = await Promise.all([createAdmin(), createAdmin()]);
    const actor = actorOf(["admin"]);

    // Разные пути изменения прав обязаны делить один и тот же замок.
    const results = await Promise.allSettled([
      assignRoles(a.id, ["secretary"], actor),
      setUserActive(b.id, false, actor)
    ]);

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectionText(results)).toMatch(/хотя бы один администратор/);
    expect(await adminsWhoCanLogin()).toHaveLength(1);
  });

  test("при трёх администраторах параллельные снятия проходят оба", async () => {
    const [a, b, c] = await Promise.all([createAdmin(), createAdmin(), createAdmin()]);
    const actor = actorOf(["admin"]);

    const results = await Promise.allSettled([
      assignRoles(a.id, ["executor"], actor),
      assignRoles(b.id, ["executor"], actor)
    ]);

    // Замок не должен превращаться в запрет: пока администраторов хватает, отказывать не за что.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await adminsWhoCanLogin()).toEqual([c.id]);
  });
});

describe("обычные снятия прав не сломались", () => {
  test("при двух администраторах снятие прав проходит, и права можно вернуть", async () => {
    const [a, b] = await Promise.all([createAdmin(), createAdmin()]);
    const actor = actorOf(["admin"]);

    const updated = await assignRoles(a.id, ["executor"], actor);
    expect(updated.roles).toEqual(["executor"]);
    expect(await adminsWhoCanLogin()).toEqual([b.id]);

    const back = await assignRoles(a.id, ["admin"], actor);
    expect(back.roles).toEqual(["admin"]);
    expect(await adminsWhoCanLogin()).toHaveLength(2);
  });

  test("последнего администратора не снять и не заблокировать — отказа не остаётся следов", async () => {
    const a = await createAdmin();
    const actor = actorOf(["admin"]);
    const ts = new Date().toISOString();
    await insertSession({
      id: "sess-1",
      userId: a.id,
      createdAt: ts,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastSeenAt: ts,
      userAgent: "jest",
      ip: "127.0.0.1"
    });

    await expect(assignRoles(a.id, ["executor"], actor)).rejects.toThrow(/хотя бы один администратор/);
    await expect(setUserActive(a.id, false, actor)).rejects.toThrow(/хотя бы один администратор/);

    // Отказ не оставил следов: роль на месте, блокировки нет, сессия жива, аудит пуст.
    expect(await getUserRoles(a.id)).toEqual(["admin"]);
    expect((await getUser(a.id))!.blocked).toBe(false);
    expect(await getSession("sess-1")).not.toBeNull();
    expect(await listAudit({ limit: 100 })).toHaveLength(0);
  });
});

describe("порядок блокировок", () => {
  test("общий замок берётся до строк: чужая смена прав не даёт взаимной блокировки", async () => {
    const a = await createAdmin();
    await createAdmin(); // второй администратор: система без администратора остаться не должна
    const actor = actorOf(["admin"]);
    const client = await getDocflowPool().connect();
    let op: ReturnType<typeof setUserActive> | null = null;
    let rowLockError = "";
    let settled = false;
    try {
      // Другая смена прав уже держит общий замок...
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ADMIN_CHANGES_LOCK_KEY]);

      // ...наша операция встаёт в очередь на нём и при этом НЕ держит строку
      // пользователя. Иначе «строка → замок» (мы) и «замок → строка» (сосед)
      // сошлись бы во взаимную блокировку, а синхронизация справочника держит
      // строки пользователей пачкой в своей транзакции.
      op = setUserActive(a.id, false, actor);
      void op.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await sleep(150);
      expect(settled).toBe(false);

      // Строка занята чужой транзакцией и правится без помех — значит, наша её не держит.
      rowLockError = await client
        .query("UPDATE users SET updated_at = $1 WHERE id = $2", [new Date().toISOString(), a.id])
        .then(
          () => "",
          (e: Error) => e.message
        );
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }

    expect(rowLockError).toBe("");
    expect((await op!).blocked).toBe(true);
  }, 15000);
});

describe("администратором считается только тот, кто может войти", () => {
  test("уволенный админ прав не удерживает: последнего действующего не снять и не заблокировать", async () => {
    const acting = await createAdmin();
    const fired = await createAdmin({ isActive: false });
    const actor = actorOf(["admin"]);
    expect(await adminsWhoCanLogin()).toEqual([acting.id]);

    await expect(assignRoles(acting.id, ["executor"], actor)).rejects.toThrow(/хотя бы один администратор/);
    await expect(setUserActive(acting.id, false, actor)).rejects.toThrow(/хотя бы один администратор/);

    // А уволенного разжаловать по-прежнему можно: администратором он уже не является.
    const demoted = await assignRoles(fired.id, ["executor"], actor);
    expect(demoted.roles).toEqual(["executor"]);
    expect(await adminsWhoCanLogin()).toEqual([acting.id]);

    // Отказы не тронули действующего администратора.
    expect(await getUserRoles(acting.id)).toEqual(["admin"]);
    expect((await getUser(acting.id))!.blocked).toBe(false);
  });

  test("заблокированный админ тоже не считается действующим", async () => {
    const acting = await createAdmin();
    const blocked = await createAdmin({ blocked: true });
    const actor = actorOf(["admin"]);
    expect(await adminsWhoCanLogin()).toEqual([acting.id]);

    await expect(setUserActive(acting.id, false, actor)).rejects.toThrow(/хотя бы один администратор/);
    // Разжаловать заблокированного можно: войти он всё равно не может.
    const demoted = await assignRoles(blocked.id, ["executor"], actor);
    expect(demoted.roles).toEqual(["executor"]);
  });

  test("двум действующим администраторам снятие прав не ломает, уволенный не мешает", async () => {
    const a = await createAdmin();
    const b = await createAdmin();
    await createAdmin({ isActive: false });

    const updated = await assignRoles(a.id, ["executor"], actorOf(["admin"]));
    expect(updated.roles).toEqual(["executor"]);
    expect(await adminsWhoCanLogin()).toEqual([b.id]);
  });
});

describe("hasAdmin: «действующий администратор» — тот, кто может войти", () => {
  test("уволенный или заблокированный администратор не считается действующим", async () => {
    await createAdmin({ isActive: false });
    expect(await countActingAdmins()).toBe(0);
    // Ни войти, ни выдать права такой администратор не может — статус обязан это показать,
    // иначе предупреждение первого запуска не появится.
    expect(await hasAdmin()).toBe(false);
    expect((await authStatus()).hasAdmin).toBe(false);

    await createAdmin({ blocked: true });
    expect(await hasAdmin()).toBe(false);

    // Появился тот, кто реально может войти, — предупреждение снимается.
    await createAdmin();
    expect(await hasAdmin()).toBe(true);
    expect((await authStatus()).hasAdmin).toBe(true);
  });
});

describe("удаление учётки не отбирает последнего администратора", () => {
  test("удалить последнего действующего администратора нельзя", async () => {
    const acting = await createAdmin();
    await createAdmin({ isActive: false });

    await expect(deleteUser(acting.id)).rejects.toThrow(/хотя бы один администратор/);
    expect(await getUser(acting.id)).not.toBeNull();
    expect(await getUserRoles(acting.id)).toEqual(["admin"]);
    expect(await adminsWhoCanLogin()).toEqual([acting.id]);
  });

  test("удалить уволенного администратора можно", async () => {
    const acting = await createAdmin();
    const fired = await createAdmin({ isActive: false });

    await deleteUser(fired.id);
    expect(await getUser(fired.id)).toBeNull();
    expect(await adminsWhoCanLogin()).toEqual([acting.id]);
  });

  test("два параллельных удаления двух последних администраторов: проходит ровно одно", async () => {
    const [a, b] = await Promise.all([createAdmin(), createAdmin()]);

    const results = await Promise.allSettled([deleteUser(a.id), deleteUser(b.id)]);

    expect(fulfilledCount(results)).toBe(1);
    expect(rejectionText(results)).toMatch(/хотя бы один администратор/);
    expect(await adminsWhoCanLogin()).toHaveLength(1);
  });
});
