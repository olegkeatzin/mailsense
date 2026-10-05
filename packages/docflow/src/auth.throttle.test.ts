import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb as initCoreDb, closeDb as closeCoreDb } from "../../core/src/db/index.js";
import { closeDocflowDb, getDocflowPool, initDocflowDb } from "./db/index.js";
import { hashPassword, listAudit, login } from "./index.js";
import { insertUser } from "./repo.js";
import { setSetting } from "./settings.js";
import { DEFAULT_THROTTLE, resetLoginThrottle } from "./loginThrottle.js";

/**
 * Перебор пароля через login().
 *
 * Перебирая пароль, можно заблокировать доменную учётную запись (политика AD),
 * поэтому перебор обязан останавливать сам сервер. Проверяем приёмочный сценарий:
 * после N неудач отказывает даже верный пароль, а успешный вход счётчик сбрасывает.
 * Неудачные попытки обязаны остаться в аудите — и без пароля в нём.
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

const PASSWORD = "Brute123!";
const N = DEFAULT_THROTTLE.maxLoginFailures;

let dir = "";
let bruteId = "";
let otherId = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-throttle-"));
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
  resetLoginThrottle();
  await getDocflowPool().query("TRUNCATE users, user_roles, sessions, audit_log, settings RESTART IDENTITY CASCADE");
  const brute = await insertUser({
    ldapUid: "brute",
    email: "brute@stand.test",
    fullName: "Перебирающий П.П.",
    source: "local",
    passwordHash: hashPassword(PASSWORD)
  });
  const other = await insertUser({
    ldapUid: "other",
    email: "other@stand.test",
    fullName: "Сотрудник С.С.",
    source: "local",
    passwordHash: hashPassword(PASSWORD)
  });
  bruteId = brute.id;
  otherId = other.id;
  await setSetting("auth.localLoginEnabled", "true");
});

/** Неудачная попытка входа: сервер обязан отказать и посчитать её. */
async function failOnce(who = "brute", password = "неверный", ip?: string): Promise<void> {
  await expect(login({ login: who, password, ip })).rejects.toThrow(/Неверный логин или пароль/);
}

describe("перебор пароля", () => {
  test("после N неудач отказывает даже верный пароль", async () => {
    for (let i = 0; i < N; i++) await failOnce();
    // Пароль верный — но перебор уже остановлен.
    await expect(login({ login: "brute", password: PASSWORD })).rejects.toThrow(/Слишком много неудачных попыток/);
    resetLoginThrottle();
    // и только сброс счётчика возвращает вход (в бою — по времени блокировки)
    const ok = await login({ login: "brute", password: PASSWORD });
    expect(ok.user.id).toBe(bruteId);
  });

  test("успешный вход сбрасывает счётчик: следующие N-1 неудач снова не блокируют", async () => {
    for (let i = 0; i < N - 1; i++) await failOnce();
    const ok = await login({ login: "brute", password: PASSWORD });
    expect(ok.user.id).toBe(bruteId);

    for (let i = 0; i < N - 1; i++) await failOnce();
    const again = await login({ login: "brute", password: PASSWORD });
    expect(again.user.id).toBe(bruteId);
  });

  test("блокировка одного логина не мешает войти другому", async () => {
    for (let i = 0; i < N; i++) await failOnce("brute");
    const ok = await login({ login: "other", password: PASSWORD });
    expect(ok.user.id).toBe(otherId);
  });

  test("неудачные попытки попадают в аудит, пароль в аудит не пишется", async () => {
    await failOnce("brute", "Секрет-Который-Нельзя-Логировать");
    const entries = await listAudit({ limit: 100 });
    const denied = entries.filter((e) => e.action === "login_failed");
    expect(denied.length).toBe(1);
    expect(denied[0].entityId).toBe("brute");
    expect(denied[0].newValue).toContain("invalid_credentials");
    expect(JSON.stringify(entries)).not.toContain("Секрет-Который-Нельзя-Логировать");
  });

  test("попытка во время блокировки тоже попадает в аудит", async () => {
    for (let i = 0; i < N; i++) await failOnce("brute");
    await expect(login({ login: "brute", password: PASSWORD })).rejects.toThrow(/Слишком много/);
    const entries = await listAudit({ limit: 100 });
    expect(entries.some((e) => e.action === "login_blocked")).toBe(true);
  });

  test("успешный вход по-прежнему работает (счётчик не мешает обычной работе)", async () => {
    const ok = await login({ login: "brute", password: PASSWORD });
    expect(ok.token).toBeTruthy();
    expect(ok.user.id).toBe(bruteId);
  });
});
