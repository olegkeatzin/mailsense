import { getAccounts } from "./accountService.js";
import { fetchEmails } from "./mailService.js";
import { getSettingValue } from "./settingsService.js";
import { logger } from "../logger.js";

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/**
 * Планировщик автоматической проверки почты (настраиваемый интервал).
 * Использует setTimeout-цепочку, чтобы интервал читался динамически и не было наложений.
 */
export function startMailScheduler(): void {
  if (timer) return;
  stopped = false;
  logger.info("Планировщик проверки почты запущен");

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const accounts = getAccounts();
      for (const a of accounts) {
        try {
          await fetchEmails(a.id);
        } catch (err) {
          logger.warn(
            { account: a.username, err: (err as Error).message },
            "Ошибка авто-проверки аккаунта"
          );
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
