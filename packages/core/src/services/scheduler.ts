import { getAccounts } from "./accountService.js";
import { fetchEmails, isFetching } from "./mailService.js";
import { getSettingValue } from "./settingsService.js";
import { logger } from "../logger.js";

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/** На сколько часов назад отматываем точку синхронизации (запас на расхождение часов сервера). */
const SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Планировщик автоматической проверки почты (настраиваемый интервал).
 * Использует setTimeout-цепочку, чтобы интервал читался динамически и не было наложений.
 *
 * Важно: авто-проверка НЕ сканирует весь ящик. Она забирает письма только
 * начиная с последней успешной синхронизации аккаунта (lastFetchAt). Пока
 * синхронизации не было, авто-скан молчит — первичный скан запускает пользователь
 * (кнопка «Скан»), при необходимости с диапазоном дат.
 */
export function startMailScheduler(): void {
  if (timer) return;
  stopped = false;
  logger.info("Планировщик проверки почты запущен");

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (getSettingValue("auto_fetch", "true") !== "false") {
        const accounts = getAccounts();
        for (const a of accounts) {
          try {
            if (isFetching(a.id)) continue;
            const last = typeof a.settings.lastFetchAt === "string" ? a.settings.lastFetchAt : null;
            if (!last) continue; // нет точки отсчёта — не сканируем весь ящик автоматически
            const sinceMs = Date.parse(last) - SYNC_OVERLAP_MS;
            if (Number.isNaN(sinceMs)) continue;
            const since = new Date(sinceMs).toISOString().slice(0, 10);
            await fetchEmails(a.id, { since });
          } catch (err) {
            logger.warn(
              { account: a.username, err: (err as Error).message },
              "Ошибка авто-проверки аккаунта"
            );
          }
        }
      }
    } finally {
      if (!stopped) {
        const sec = Math.max(10, Number(getSettingValue("pollIntervalSeconds", "60")) || 60);
        timer = setTimeout(() => void tick(), sec * 1000);
      }
    }
  };

  void tick();
}

export function stopMailScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
