import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { createManualUser, updateManualUser } from "./users.js";
import { getUser, insertUser } from "./repo.js";
import type { AuthUser } from "./types.js";

/**
 * Целостность справочника по email.
 *
 * Проверка дубля одними глазами приложения не работает: два одновременных запроса
 * проходят её оба. Гарантия обязана быть в базе (уникальный индекс), а приложение —
 * объяснять конфликт понятным текстом, а не отдавать наружу ошибку PostgreSQL.
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
let actor: AuthUser;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await getDocflowPool().query<{ n: number }>(sql, params);
  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-email-"));
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
  const admin = await insertUser({ email: "admin@stand.test", fullName: "Администратор", source: "manual" });
  actor = { ...admin, roles: ["admin"] };
});

describe("уникальность email обеспечена базой", () => {
  test("прямая вставка дубля отклоняется индексом, а не только кодом", async () => {
    const ts = new Date().toISOString();
    await insertUser({ email: "client@example.com", fullName: "Первый", source: "manual" });
    // Мимо приложения: если гарантия только в JS, эта вставка пройдёт.
    await expect(
      getDocflowPool().query(
        "INSERT INTO users (id, email, full_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
        ["raw-dup", "CLIENT@example.com", "Дубль", ts, ts]
      )
    ).rejects.toThrow(/duplicate key|users_email_uniq/);
  });

  test("учётки без email не конфликтуют между собой", async () => {
    // Пустой адрес — законное состояние (аварийная локальная учётка), таких может быть много.
    await insertUser({ fullName: "Без адреса 1", source: "local" });
    await insertUser({ fullName: "Без адреса 2", source: "local" });
    expect(await count("SELECT count(*)::int AS n FROM users WHERE email = ''")).toBe(2);
  });

  test("регистр адреса не создаёт второго человека", async () => {
    await insertUser({ email: "Client@Example.com", fullName: "Первый", source: "manual" });
    await expect(
      createManualUser({ email: "  client@example.com ", fullName: "Второй" }, actor)
    ).rejects.toThrow(/уже есть/);
    expect(await count("SELECT count(*)::int AS n FROM users WHERE lower(email) = $1", ["client@example.com"])).toBe(1);
  });
});

describe("понятные ошибки вместо ошибок PostgreSQL", () => {
  test("ручное создание с занятым email отклоняется понятным текстом", async () => {
    await insertUser({ email: "client@example.com", fullName: "Первый", source: "manual" });
    await expect(createManualUser({ email: "client@example.com", fullName: "Второй" }, actor)).rejects.toThrow(
      /Пользователь с таким email уже есть/
    );
    expect(await count("SELECT count(*)::int AS n FROM users")).toBe(2); // админ + первый
  });

  test("правка email на занятый отклоняется, адрес не меняется", async () => {
    const a = await insertUser({ email: "a@example.com", fullName: "Первый", source: "manual" });
    const b = await insertUser({ email: "b@example.com", fullName: "Второй", source: "manual" });
    await expect(updateManualUser(b.id, { email: "a@example.com" }, actor)).rejects.toThrow(/уже есть/);
    expect((await getUser(a.id))!.email).toBe("a@example.com");
    expect((await getUser(b.id))!.email).toBe("b@example.com");
  });

  test("правка прочих полей при занятом своим же адресом не ломается", async () => {
    const b = await insertUser({ email: "b@example.com", fullName: "Второй", source: "manual" });
    const updated = await updateManualUser(b.id, { email: "b@example.com", fullName: "Второй (уточнено)" }, actor);
    expect(updated.fullName).toBe("Второй (уточнено)");
  });

  test("проверка дубля не тянет весь справочник: вставляем много пользователей", async () => {
    await insertUser({ email: "many@example.com", fullName: "Много", source: "manual" });
    const ts = new Date().toISOString();
    await getDocflowPool().query(
      "INSERT INTO users (id, email, full_name, created_at, updated_at) " +
        "SELECT 'bulk-' || g, 'bulk-' || g || '@example.com', 'Пользователь ' || g, $1, $1 FROM generate_series(1, 300) g",
      [ts]
    );
    await expect(createManualUser({ email: "many@example.com", fullName: "Дубль" }, actor)).rejects.toThrow(/уже есть/);
    const created = await createManualUser({ email: "fresh@example.com", fullName: "Новый" }, actor);
    expect(created.email).toBe("fresh@example.com");
  });
});
