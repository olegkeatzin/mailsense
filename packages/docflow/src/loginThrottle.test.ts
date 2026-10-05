import {
  DEFAULT_THROTTLE,
  MAX_TRACKED_KEYS,
  checkLoginAllowed,
  loginThrottleSize,
  noteLoginFailure,
  noteLoginSuccess,
  resetLoginThrottle
} from "./loginThrottle.js";

/**
 * Счётчик неудачных попыток входа.
 *
 * Смысл: перебор пароля к учётной записи AD приводит к её блокировке в домене
 * (политика AD), поэтому сервер обязан остановить перебор сам — до каталога.
 * Здесь проверяется сама арифметика счётчика, интеграция в login() — в auth.throttle.test.ts.
 */
const N = DEFAULT_THROTTLE.maxLoginFailures;

beforeEach(() => {
  resetLoginThrottle();
});

describe("счётчик неудач по логину", () => {
  test("первые неудачи вход не блокируют", () => {
    for (let i = 0; i < N - 1; i++) noteLoginFailure("ivanov");
    expect(checkLoginAllowed("ivanov").blocked).toBe(false);
  });

  test("после N неудач логин блокируется и указывается срок", () => {
    for (let i = 0; i < N; i++) noteLoginFailure("ivanov");
    const check = checkLoginAllowed("ivanov");
    expect(check.blocked).toBe(true);
    expect(check.retryAfterMs).toBeGreaterThan(0);
    expect(check.retryAfterMs).toBeLessThanOrEqual(DEFAULT_THROTTLE.lockoutMs);
  });

  test("успешный вход сбрасывает счётчик", () => {
    for (let i = 0; i < N - 1; i++) noteLoginFailure("ivanov");
    noteLoginSuccess("ivanov");
    expect(checkLoginAllowed("ivanov").failures).toBe(0);
    expect(checkLoginAllowed("ivanov").blocked).toBe(false);
  });

  test("блокировка одного логина не задевает остальные", () => {
    for (let i = 0; i < N; i++) noteLoginFailure("ivanov");
    expect(checkLoginAllowed("petrov").blocked).toBe(false);
  });

  test("регистр логина не создаёт второй счётчик", () => {
    for (let i = 0; i < N; i++) noteLoginFailure("Ivanov");
    expect(checkLoginAllowed("ivanov").blocked).toBe(true);
  });

  test("блокировка истекает по времени", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < N; i++) noteLoginFailure("ivanov", null, DEFAULT_THROTTLE, t0);
    expect(checkLoginAllowed("ivanov", null, DEFAULT_THROTTLE, t0).blocked).toBe(true);
    const later = t0 + DEFAULT_THROTTLE.lockoutMs + 1;
    expect(checkLoginAllowed("ivanov", null, DEFAULT_THROTTLE, later).blocked).toBe(false);
  });

  test("неудачи старше окна не считаются", () => {
    const t0 = 5_000_000;
    const old = t0 + DEFAULT_THROTTLE.windowMs + 1;
    for (let i = 0; i < N - 1; i++) noteLoginFailure("ivanov", null, DEFAULT_THROTTLE, t0);
    // окно прошло: счётчик начинается заново, а не «дозревает» до блокировки
    noteLoginFailure("ivanov", null, DEFAULT_THROTTLE, old);
    expect(checkLoginAllowed("ivanov", null, DEFAULT_THROTTLE, old).failures).toBe(1);
    expect(checkLoginAllowed("ivanov", null, DEFAULT_THROTTLE, old).blocked).toBe(false);
  });
});

describe("счётчик неудач по адресу", () => {
  test("порог по адресу выше: опечатки соседей за одним NAT офис не блокируют", () => {
    for (let i = 0; i < N; i++) noteLoginFailure("user-" + i, "10.0.0.1");
    expect(checkLoginAllowed("user-99", "10.0.0.1").blocked).toBe(false);
    expect(checkLoginAllowed("user-99").blocked).toBe(false);
  });

  test("превышение порога по адресу блокирует любой логин с него, но не с другого", () => {
    for (let i = 0; i < DEFAULT_THROTTLE.maxIpFailures; i++) noteLoginFailure("user-" + i, "10.0.0.1");
    expect(checkLoginAllowed("user-99", "10.0.0.1").blocked).toBe(true);
    expect(checkLoginAllowed("user-99", "10.0.0.2").blocked).toBe(false);
  });

  test("пустой адрес не превращается в общий счётчик для всех", () => {
    for (let i = 0; i < N; i++) noteLoginFailure("user-" + i, "");
    expect(checkLoginAllowed("user-99", "").blocked).toBe(false);
  });
});

describe("память счётчика", () => {
  test("случайные логины не растут в памяти бесконечно", () => {
    for (let i = 0; i < 20000; i++) noteLoginFailure("random-" + i, "10.0.0.1");
    // +1 — единственный ключ второго счётчика (адрес): у каждого счётчика свой предел.
    expect(loginThrottleSize()).toBeLessThanOrEqual(MAX_TRACKED_KEYS + 1);
  });
});
