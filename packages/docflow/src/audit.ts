import { logger } from "@mailsense/core/directory";
import { insertAudit, type DocflowExecutor } from "./repo.js";
import type { AuditEntry, AuditInput } from "./types.js";

/**
 * Запись аудита ВНУТРИ транзакции изменения.
 *
 * Ошибку НЕ глотаем: если след не записался, транзакция откатится вместе с самим
 * изменением. Иначе изменение прошло бы без следа, а искать виноватого будет нечем
 * (AGENTS.md, п. 4: «Аудит обязан писаться в той же транзакции, что и изменение»).
 */
export async function auditInTx(exec: DocflowExecutor, input: AuditInput): Promise<AuditEntry> {
  return insertAudit(input, exec);
}

/**
 * Аудит действий ВНЕ транзакции изменения.
 *
 * ⚠️ Только для записей, которые по смыслу не являются следом изменения:
 * например, «попытка отклонена» — она пишется после отката и намеренно не
 * откатывает ничего. Ошибка здесь логируется, операцию не ломает.
 * Для следа изменения используется auditInTx в его транзакции.
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
