import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { login } from "./auth.js";
import { syncDirectoryUsers } from "./users.js";
import { getSession, getUser, getUserByLdapUid, insertSession, insertUser, listAudit } from "./repo.js";
import type { LdapProfile } from "@mailsense/core/directory";

/**
 * Синхронизация справочника с каталогом.
 *
 * Две беды, которые здесь проверяются:
 * 1) дубль адреса в каталоге (общий ящик, контрагент, заведённый вручную) ронял ВСЮ
 *    транзакцию синхронизации: справочник не обновлялся вообще, наружу шёл 500;
 * 2) каталог длиннее предела выгрузки — неполный список нельзя принимать за «этих
 *    людей в каталоге больше нет»: деактивация выключила бы живых сотрудников.
 */
jest.mock("@mailsense/core/directory", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  getLdapSettings: jest.fn(() => ({ url: "ldaps://ldap.test:636", baseDn: "dc=test", bindDn: "", bindPassword: "" })),
  directoryCredentials: jest.fn(() => ({ login: "ldap-bind@test", password: "bind-pass" })),
  ldapListProfiles: jest.fn(),
  ldapAuthenticate: jest.fn(),
  ldapFailureMessage: jest.fn(() => "Каталог недоступен"),
  LdapError: class LdapError extends Error {}
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const directory = require("@mailsense/core/directory") as {
  ldapListProfiles: jest.Mock;
  ldapAuthenticate: jest.Mock;
};

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-sync-"));
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
  directory.ldapListProfiles.mockReset();
  directory.ldapAuthenticate.mockReset();
});

const IVANOV: LdapProfile = {
  dn: "cn=Ivanov,dc=test",
  ldapUid: "ivanov",
  email: "ivanov@test.local",
  fullName: "Иванов И.И.",
  department: "Аппарат",
  position: "Специалист",
  phone: "1",
  managerDn: null,
  disabled: false
};

/** Ответ каталога в новой форме: список + признак обрезки (LdapProfilesResult). */
function batch(
  profiles: LdapProfile[],
  opts: { total?: number; truncated?: boolean } = {}
): { profiles: LdapProfile[]; total: number; truncated: boolean } {
  return { profiles, total: opts.total ?? profiles.length, truncated: opts.truncated ?? false };
}

describe("дубль адреса в каталоге", () => {
  test("не роняет всю синхронизацию: остальные обновлены, о конфликте сообщено", async () => {
    // Адрес уже занят: общий ящик, контрагент или учётка, заведённая вручную.
    const shared = await insertUser({
      ldapUid: "shared",
      email: "shared@test.local",
      fullName: "Общий ящик",
      source: "manual"
    });
    directory.ldapListProfiles.mockResolvedValue(
      batch([IVANOV, { ...IVANOV, ldapUid: "petrov", dn: "cn=Petrov", email: "shared@test.local", fullName: "Петров П.П." }])
    );

    // Раньше здесь падала вся транзакция: справочник не обновлялся, наружу — 500.
    const res = await syncDirectoryUsers(null);

    expect(res.created).toBe(2);
    expect(res.emailConflicts).toEqual([{ ldapUid: "petrov", email: "shared@test.local" }]);
    expect((await getUserByLdapUid("ivanov"))?.email).toBe("ivanov@test.local");

    const petrov = await getUserByLdapUid("petrov");
    expect(petrov).not.toBeNull();
    // Чужой адрес не отобран и не продублирован: человек в справочнике, но без адреса.
    expect(petrov?.email).toBe("");
    expect(petrov?.fullName).toBe("Петров П.П.");
    expect((await getUser(shared.id))?.email).toBe("shared@test.local");
    // След синхронизации на месте — транзакция не откатилась.
    expect(await listAudit({ action: "directory.sync", limit: 10 })).toHaveLength(1);
  });

  test("существующему сотруднику не подменяют адрес на занятый, кадровые данные применяются", async () => {
    await insertUser({ ldapUid: "shared", email: "shared@test.local", fullName: "Общий ящик", source: "manual" });
    const petrov = await insertUser({
      ldapUid: "petrov",
      email: "petrov@test.local",
      fullName: "Петров",
      source: "ldap"
    });
    directory.ldapListProfiles.mockResolvedValue(
      batch([{ ...IVANOV, ldapUid: "petrov", email: "shared@test.local", department: "Новый отдел" }])
    );

    const res = await syncDirectoryUsers(null);

    expect(res.updated).toBe(1);
    expect(res.emailConflicts).toHaveLength(1);
    const after = await getUser(petrov.id);
    expect(after?.email).toBe("petrov@test.local");
    expect(after?.department).toBe("Новый отдел");
  });

  test("вход сотрудника с дублирующимся адресом не даёт 500", async () => {
    await insertUser({ ldapUid: "shared", email: "shared@test.local", fullName: "Общий ящик", source: "manual" });
    directory.ldapAuthenticate.mockResolvedValue({
      ...IVANOV,
      ldapUid: "petrov",
      dn: "cn=Petrov,dc=test",
      email: "shared@test.local",
      fullName: "Петров П.П."
    });

    const res = await login({ login: "petrov", password: "PetrovPass123!" });

    expect(res.user.ldapUid).toBe("petrov");
    expect(res.user.email).toBe("");
    expect((await getUserByLdapUid("shared"))?.email).toBe("shared@test.local");
    expect(res.token).toBeTruthy();
  });
});

describe("неполный список каталога", () => {
  test("обрезка по пределу выгрузки не выключает отсутствующих", async () => {
    const gone = await insertUser({
      ldapUid: "sidorov",
      email: "sidorov@test.local",
      fullName: "Сидоров С.С.",
      source: "ldap"
    });
    const ts = new Date().toISOString();
    await insertSession({
      id: "sess-gone",
      userId: gone.id,
      createdAt: ts,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastSeenAt: ts,
      userAgent: "jest",
      ip: "127.0.0.1"
    });
    directory.ldapListProfiles.mockResolvedValue(batch([IVANOV], { total: 7000, truncated: true }));

    const res = await syncDirectoryUsers(null);

    expect(res.incomplete).toBe(true);
    expect(res.deactivated).toBe(0);
    expect((await getUser(gone.id))!.isActive).toBe(true);
    // Сессии живых людей не рвём: «нет в списке» ничего не доказывает.
    expect(await getSession("sess-gone")).not.toBeNull();
  });

  test("пустой ответ каталога не выключает справочник", async () => {
    const u = await insertUser({ ldapUid: "sidorov", email: "sidorov@test.local", fullName: "Сидоров", source: "ldap" });
    // Пустой каталог — почти всегда неверный Base DN, а не вымерший дом.
    directory.ldapListProfiles.mockResolvedValue({ profiles: [], total: 0, truncated: false });

    const res = await syncDirectoryUsers(null);

    expect(res.incomplete).toBe(true);
    expect(res.deactivated).toBe(0);
    expect((await getUser(u.id))!.isActive).toBe(true);
  });

  test("полный список по-прежнему выключает ушедших из каталога", async () => {
    const gone = await insertUser({ ldapUid: "sidorov", email: "sidorov@test.local", fullName: "Сидоров", source: "ldap" });
    directory.ldapListProfiles.mockResolvedValue(batch([IVANOV], { total: 1, truncated: false }));

    const res = await syncDirectoryUsers(null);

    expect(res.incomplete).toBe(false);
    expect(res.deactivated).toBe(1);
    expect((await getUser(gone.id))!.isActive).toBe(false);
  });
});
