import { logger } from "@mailsense/core/directory";
import { insertAudit } from "./repo.js";
import type { AuditEntry, AuditInput } from "./types.js";

/**
 * Аудит действий. Пишется на сервере на каждую значимую мутацию.
 * Ошибка записи аудита не должна ломать основную операцию — только логируется.
 */
export async function writeAudit(input: AuditInput): Promise<AuditEntry | null> {
  try {
    return await insertAudit(input);
  } catch (err) {
    logger.warn({ err: (err as Error).message, action: input.action }, "Не удалось записать аудит");
    return null;
  }
}

export async function audit(action: string, opts: Omit<AuditInput, "action"> = {}): Promise<AuditEntry | null> {
  return writeAudit({ action, ...opts });
}
