import { getSetting, normalizeBlankValues, resetReadyWithoutAnalysis, setSetting } from "../repos.js";
import { rebuildThreads } from "./threadService.js";
import { logger } from "../logger.js";

/**
 * Версия обслуживания данных. При смене выполняется одноразовая починка:
 *  - пустые строки в необязательных полях (дата события, внешний номер, дата
 *    отправки) превращаются в NULL: иначе они остаются миной для следующего
 *    фильтра, который не знает про эту особенность;
 *  - снимается ложный статус «Готово» у писем без результата анализа;
 *  - беседы пересобираются по единому алгоритму (склейка разъединённых переписок).
 */
const MAINTENANCE_VERSION = "3";

export interface MaintenanceResult {
  ran: boolean;
  resetStatuses: number;
  rethreaded: number;
  /** Сколько пустых строк в необязательных полях превращено в NULL. */
  normalizedBlanks: number;
}

export function runStartupMaintenance(force = false): MaintenanceResult {
  if (!force && getSetting("maintenance.version") === MAINTENANCE_VERSION) {
    return { ran: false, resetStatuses: 0, rethreaded: 0, normalizedBlanks: 0 };
  }
  try {
    const normalizedBlanks = normalizeBlankValues();
    const resetStatuses = resetReadyWithoutAnalysis();
    const rethreaded = rebuildThreads();
    setSetting("maintenance.version", MAINTENANCE_VERSION);
    logger.info({ resetStatuses, rethreaded, normalizedBlanks }, "Обслуживание данных выполнено");
    return { ran: true, resetStatuses, rethreaded, normalizedBlanks };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Ошибка обслуживания данных");
    return { ran: false, resetStatuses: 0, rethreaded: 0, normalizedBlanks: 0 };
  }
}
