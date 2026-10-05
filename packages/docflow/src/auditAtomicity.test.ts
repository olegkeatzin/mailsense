import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { getUser, insertUser, setUserRoles } from "./repo.js";
import {
  assignRoles,
  createManualUser,
  setUserActive,
  updateManualUser
} from "./users.js";
import {
  archivePeriod,
  ensureCorrespondent,
  linkDocumentEmail,
  registerDocument,
  saveCase,
  saveCorrespondent,
  type Actor
} from "./journal.js";
import type { AuthUser, User } from "./types.js";

/**
 * Инвариант из AGENTS.md (пункт 4): «Аудит обязан писаться в той же транзакции,
 * что и изменение». Иначе при сбое записи аудита изменение пройдёт без следа —
 * а искать виноватого будет нечем.
 *
 * Проверяем не «есть ли строка в аудите», а само свойство атомарности: отказываем
 * запись в audit_log на уровне СУБД (BEFORE INSERT триггер) и требуем, чтобы
 * изменения не случилось вовсе. На прежнем коде (writeAudit глотает ошибку)
 * изменение оставалось — эти тесты падали.
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

const actor0: Actor = { id: "u-secretary", name: "Авдеева Ю.Н." };

let dir = "";
let actor: AuthUser;
let target: User;

/** Запись в audit_log падает с ошибкой СУБД — ровно то, что бывает при сбое. */
async function blockAudit(): Promise<void> {
  await getDocflowPool().query(
    "CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger AS $$ " +
      "BEGIN RAISE EXCEPTION 'тест: запись аудита недоступна'; END; $$ LANGUAGE plpgsql; " +
      "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; " +
      "CREATE TRIGGER test_block_audit_trg BEFORE INSERT ON audit_log " +
      "FOR EACH ROW EXECUTE FUNCTION test_block_audit();"
  );
}

async function unblockAudit(): Promise<void> {
  await getDocflowPool().query(
    "DROP TRIGGER IF EXISTS test_block_audit_trg ON audit_log; DROP FUNCTION IF EXISTS test_block_audit();"
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(sql, params);
  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-audit-"));
  initCoreDb(dir);
  await initDocflowDb(TEST_DB_URL);
});

afterAll(async () => {
  await unblockAudit().catch(() => undefined);
  await closeDocflowDb();
  closeCoreDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

beforeEach(async () => {
  await unblockAudit();
  await getDocflowPool().query(
    "TRUNCATE users, user_roles, sessions, audit_log, documents, document_emails, " +
      "number_counters, number_archives, case_nomenclature, correspondents, roles RESTART IDENTITY CASCADE"
  );
  // Встроенные роли создаёт миграция — вернём их после TRUNCATE roles.
  await getDocflowPool().query(
    "INSERT INTO roles (id, name, description, sort_order, is_system) VALUES " +
      "('admin','Администратор','',1,true),('secretary','Аппарат','',2,true)," +
      "('manager','Руководитель','',3,true),('executor','Исполнитель','',4,true)," +
      "('signer','Подписант','',5,true) ON CONFLICT (id) DO NOTHING"
  );
  const admin = await insertUser({ email: "admin@stand.test", fullName: "Администратор", source: "manual" });
  await setUserRoles(admin.id, ["admin"], null);
  actor = { ...admin, roles: ["admin"] };
  target = await insertUser({
    ldapUid: "petrova_ma",
    email: "petrova_ma@stand.test",
    fullName: "Петрова М.А.",
    source: "ldap"
  });
});

afterEach(async () => {
  await unblockAudit();
});

describe("смена прав и её след — одна операция", () => {
  test("сбой записи аудита откатывает смену ролей и не рвёт сессии", async () => {
    const ts = new Date().toISOString();
    await getDocflowPool().query(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) " +
        "VALUES ($1,$2,$3,$4,$5,'','')",
      ["sess-1", target.id, ts, ts, ts]
    );

    await blockAudit();
    await expect(assignRoles(target.id, ["executor"], actor)).rejects.toThrow();

    // Роли не изменились: изменение и след либо оба есть, либо обоих нет.
    expect(await count("SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1", [target.id])).toBe(0);
    // Сессия жива: разорвать её, не записав след, нельзя.
    expect(await count("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [target.id])).toBe(1);
  });

  test("успешная смена ролей пишет след аудита", async () => {
    const after = await assignRoles(target.id, ["executor"], actor);
    expect(after.roles).toEqual(["executor"]);
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.roles'")).toBe(1);
    const audit = await getDocflowPool().query<{ new_value: string }>(
      "SELECT new_value FROM audit_log WHERE action = 'user.roles'"
    );
    expect(JSON.parse(audit.rows[0].new_value).roles).toEqual(["executor"]);
  });

  test("сбой аудита не блокирует учётную запись", async () => {
    await blockAudit();
    await expect(setUserActive(target.id, false, actor)).rejects.toThrow();
    expect((await getUser(target.id))!.blocked).toBe(false);
  });

  test("сбой аудита не создаёт ручную учётку", async () => {
    await blockAudit();
    await expect(
      createManualUser({ email: "client@example.com", fullName: "Внешний контрагент" }, actor)
    ).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM users WHERE email = $1", ["client@example.com"])).toBe(0);
  });

  test("сбой аудита не применяет правку учётки", async () => {
    await blockAudit();
    await expect(updateManualUser(target.id, { fullName: "Другое Имя" }, actor)).rejects.toThrow();
    expect((await getUser(target.id))!.fullName).toBe("Петрова М.А.");
  });
});

describe("журнал и справочники: след в той же транзакции", () => {
  let documentId = "";

  beforeEach(async () => {
    const doc = await registerDocument({ summary: "Письмо о марафоне", sender: "АО «ОПК»" }, actor0);
    documentId = doc.id;
  });

  test("сбой аудита не привязывает письмо к документу", async () => {
    await blockAudit();
    await expect(linkDocumentEmail(documentId, "mail-1", "resolution", actor0)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM document_emails WHERE email_id = $1", ["mail-1"])).toBe(0);
  });

  test("сбой аудита не закрывает период архивацией", async () => {
    await blockAudit();
    await expect(
      archivePeriod({ period: "2025", fileName: "журнал-2025.xlsx", documentCount: 3 }, actor0)
    ).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM number_archives WHERE period = $1", ["2025"])).toBe(0);
  });

  test("сбой аудита не сохраняет дело номенклатуры", async () => {
    await blockAudit();
    await expect(saveCase({ code: "01-15", title: "Переписка" }, actor0)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM case_nomenclature WHERE code = $1", ["01-15"])).toBe(0);
  });

  test("сбой аудита не создаёт корреспондента при регистрации", async () => {
    await blockAudit();
    await expect(ensureCorrespondent("АО «ОПК»", actor0)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM correspondents WHERE name = $1", ["АО «ОПК»"])).toBe(0);
  });

  test("сбой аудита не сохраняет корреспондента", async () => {
    await blockAudit();
    await expect(saveCorrespondent({ name: "ПАО «Ростелеком»" }, actor0)).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM correspondents WHERE name = $1", ["ПАО «Ростелеком»"])).toBe(0);
  });
});
