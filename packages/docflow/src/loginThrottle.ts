/**
 * Защита входа от перебора пароля.
 *
 * ⚠️ Зачем это нужно именно здесь. Active Directory сам блокирует учётную запись после
 * нескольких неудачных попыток входа. Значит, перебирая пароль через наш сервер, атакующий
 * (или сломанный скрипт) блокирует доменную учётку — вплоть до администраторской.
 * Останавливать перебор обязан сервер, до обращения к каталогу.
 *
 * Неудачи считаются по логину и по адресу отдельно:
 *   - по логину порог низкий (5) — это и есть перебор конкретного пароля;
 *   - по адресу порог выше (25) — за одним адресом (NAT) сидит весь офис, и чужие
 *     опечатки не должны закрывать вход остальным.
 * Успешный вход сбрасывает оба счётчика: иначе офис копил бы чужие ошибки до блокировки.
 *
 * Задержку на каждую попытку не делаем: она замедляет перебор линейно, а временная
 * блокировка после N неудач ограничивает его сверху (5 попыток на 15 минут).
 *
 * Состояние живёт в памяти процесса: сервер документооборота один (standalone),
 * перезапуск сбрасывает счётчики. Нескольким экземплярам понадобилась бы общая
 * таблица в базе — это отдельная задача, здесь сознательно не усложняем.
 */

export interface LoginThrottlePolicy {
  /** Сколько неудач по одному логину допускается в окне. */
  maxLoginFailures: number;
  /** Сколько неудач с одного адреса допускается в окне. */
  maxIpFailures: number;
  /** Окно, в котором считаются неудачи. */
  windowMs: number;
  /** На сколько блокируется вход после превышения порога. */
  lockoutMs: number;
}

export const DEFAULT_THROTTLE: LoginThrottlePolicy = {
  maxLoginFailures: 5,
  maxIpFailures: 25,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000
};

/** Предел числа отслеживаемых ключей: случайные логины не должны растить память. */
export const MAX_TRACKED_KEYS = 5000;

export interface ThrottleCheck {
  /** Вход запрещён прямо сейчас. */
  blocked: boolean;
  /** Через сколько миллисекунд блокировка снимется. */
  retryAfterMs: number;
  /** Сколько неудач накопилось (максимум по обоим счётчикам). */
  failures: number;
}

interface Failures {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const loginFailures = new Map<string, Failures>();
const ipFailures = new Map<string, Failures>();

function keyOf(login: string): string {
  return (login ?? "").trim().toLowerCase();
}

/** Запись живёт, пока идёт окно или пока действует блокировка. */
function currentEntry(
  map: Map<string, Failures>,
  key: string,
  now: number,
  policy: LoginThrottlePolicy
): Failures | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.blockedUntil <= now && now - entry.firstAt > policy.windowMs) {
    map.delete(key);
    return null;
  }
  return entry;
}

/**
 * Чистим память, когда ключей стало слишком много: лавина случайных логинов
 * (по сути та же атака) не должна съедать память процесса.
 */
function prune(map: Map<string, Failures>, now: number, policy: LoginThrottlePolicy): void {
  if (map.size <= MAX_TRACKED_KEYS) return;
  for (const [key, entry] of map) {
    if (entry.blockedUntil <= now && now - entry.firstAt > policy.windowMs) map.delete(key);
  }
  if (map.size <= MAX_TRACKED_KEYS) return;
  const excess = map.size - MAX_TRACKED_KEYS;
  const byAge = [...map.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  for (let i = 0; i < excess; i++) map.delete(byAge[i][0]);
}

function register(
  map: Map<string, Failures>,
  key: string,
  threshold: number,
  policy: LoginThrottlePolicy,
  now: number
): void {
  const entry = currentEntry(map, key, now, policy);
  const next: Failures = entry
    ? { count: entry.count + 1, firstAt: entry.firstAt, blockedUntil: entry.blockedUntil }
    : { count: 1, firstAt: now, blockedUntil: 0 };
  if (next.count >= threshold) next.blockedUntil = now + policy.lockoutMs;
  map.set(key, next);
  prune(map, now, policy);
}

/** Можно ли пробовать войти с этим логином и адресом. */
export function checkLoginAllowed(
  login: string,
  ip?: string | null,
  policy: LoginThrottlePolicy = DEFAULT_THROTTLE,
  now: number = Date.now()
): ThrottleCheck {
  let blocked = false;
  let retryAfterMs = 0;
  let failures = 0;

  const pairs: Array<[Map<string, Failures>, string]> = [];
  const loginKey = keyOf(login);
  if (loginKey) pairs.push([loginFailures, loginKey]);
  // Пустой адрес — не «общий» ключ: иначе все клиенты без адреса делили бы счётчик.
  const ipKey = (ip ?? "").trim();
  if (ipKey) pairs.push([ipFailures, ipKey]);

  for (const [map, key] of pairs) {
    const entry = currentEntry(map, key, now, policy);
    if (!entry) continue;
    failures = Math.max(failures, entry.count);
    if (entry.blockedUntil > now) {
      blocked = true;
      retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - now);
    }
  }
  return { blocked, retryAfterMs, failures };
}

/** Неудачная попытка: считаем и, если порог перейдён, закрываем вход на окно. */
export function noteLoginFailure(
  login: string,
  ip?: string | null,
  policy: LoginThrottlePolicy = DEFAULT_THROTTLE,
  now: number = Date.now()
): ThrottleCheck {
  const loginKey = keyOf(login);
  if (loginKey) register(loginFailures, loginKey, policy.maxLoginFailures, policy, now);
  const ipKey = (ip ?? "").trim();
  if (ipKey) register(ipFailures, ipKey, policy.maxIpFailures, policy, now);
  return checkLoginAllowed(login, ip, policy, now);
}

/** Успешный вход: счётчик неудач больше не нужен. */
export function noteLoginSuccess(login: string, ip?: string | null): void {
  const loginKey = keyOf(login);
  if (loginKey) loginFailures.delete(loginKey);
  const ipKey = (ip ?? "").trim();
  if (ipKey) ipFailures.delete(ipKey);
}

/** Сколько ключей отслеживается (диагностика и тесты на утечку памяти). */
export function loginThrottleSize(): number {
  return loginFailures.size + ipFailures.size;
}

/** Полный сброс счётчиков: нужен тестам и перезапуску состояния. */
export function resetLoginThrottle(): void {
  loginFailures.clear();
  ipFailures.clear();
}
