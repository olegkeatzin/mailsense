import { logger } from "../logger.js";

/**
 * Точка «письма добавлены» после синхронизации ящика.
 *
 * Core про документооборот не знает: он объявляет место, куда владелец серверной части
 * вешает свою обработку (тот же приём, что у `LdapSettingsStore`). Благодаря этому ответ
 * руководителя распознаётся сразу после скана, а не отдельным опросом расписания.
 *
 * Ошибка обработчика НЕ должна ронять синхронизацию: письма уже сохранены, и терять
 * из-за сбоя разбора резолюции весь скан недопустимо.
 */
export interface MailSyncEvent {
  accountId: string;
  /** Идентификаторы писем, добавленных именно этим сканом. */
  addedEmailIds: string[];
}

let hook: ((event: MailSyncEvent) => Promise<void>) | null = null;

export function setMailSyncHook(fn: ((event: MailSyncEvent) => Promise<void>) | null): void {
  hook = fn;
}

export async function runMailSyncHook(event: MailSyncEvent): Promise<void> {
  if (!hook || !event.addedEmailIds.length) return;
  try {
    await hook(event);
  } catch (err) {
    logger.warn({ accountId: event.accountId, err: (err as Error).message }, "Обработчик новых писем завершился ошибкой");
  }
}