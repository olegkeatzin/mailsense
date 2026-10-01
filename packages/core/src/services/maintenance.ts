import { getSetting, resetReadyWithoutAnalysis, setSetting } from "../repos.js";
import { rebuildThreads } from "./threadService.js";
import { logger } from "../logger.js";

/**
 * Версия обслуживания данных. При смене выполняется одноразовая починка:
 *  - снимается ложный статус «Готово» у писем без результата анализа;
 *  - беседы пересобираются по единому алгоритму (склейка разъединённых переписок).
 */
const MAINTENANCE_VERSION = "2";

export interface MaintenanceResult {
  ran: boolean;
  resetStatuses: number;
  rethreaded: number;
}

export function runStartupMaintenance(force = false): MaintenanceResult {
  if (!force && getSetting("maintenance.version") === MAINTENANCE_VERSION) {
    return { ran: false, resetStatuses: 0, rethreaded: 0 };
  }
  try {
    const resetStatuses = resetReadyWithoutAnalysis();
    const rethreaded = rebuildThreads();
    setSetting("maintenance.version", MAINTENANCE_VERSION);
    logger.info({ resetStatuses, rethreaded }, "Обслуживание данных выполнено");
    return { ran: true, resetStatuses, rethreaded };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Ошибка обслуживания данных");
    return { ran: false, resetStatuses: 0, rethreaded: 0 };
  }
}
