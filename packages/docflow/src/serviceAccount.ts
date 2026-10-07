/**
 * Служебный ящик отправки (Р12, task-11): какой ящик считается служебным у аппарата.
 *
 * ⚠️ Смена служебного ящика меняет, ОТ ЧЬЕГО ИМЕНИ уходят официальные письма (письмо
 * руководителю, поручение исполнителям). Поэтому запись настройки и след аудита — одна
 * транзакция (AGENTS.md, п. 4), а не «setSetting плюс writeAudit рядом».
 */
import { eq } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import type { DocflowExecutor } from "./repo.js";
import { auditInTx } from "./audit.js";
import type { Actor } from "./journal.js";

const { settings } = docflowSchema;

/** Ключ настройки: ящик, с которого уходят служебные письма. */
export const SERVICE_ACCOUNT_SETTING = "docflow.serviceAccountId";

export interface ServiceAccountState {
  /**
   * Строка настройки существует — администратор выбор делал (в том числе ЯВНО снял его).
   * Это отличает «ещё не настроено» от «настроено и снято»: старое место настроек
   * подставляется только в первом случае (иначе «снять ящик» не отключало бы отправку —
   * поймано живой проверкой на стенде).
   */
  explicit: boolean;
  accountId: string | null;
}

export async function getServiceAccountState(exec?: DocflowExecutor): Promise<ServiceAccountState> {
  const db = exec ?? getDocflowDb();
  const rows = await db.select().from(settings).where(eq(settings.key, SERVICE_ACCOUNT_SETTING)).limit(1);
  if (rows.length === 0) return { explicit: false, accountId: null };
  const value = (rows[0].value ?? "").trim();
  return { explicit: true, accountId: value === "" ? null : value };
}

/** Выбранный служебный ящик; null — не задан или выбор снят. */
export async function getServiceAccountId(exec?: DocflowExecutor): Promise<string | null> {
  return (await getServiceAccountState(exec)).accountId;
}

/**
 * Задать служебный ящик (null — снять выбор).
 *
 * Настройка и след аудита — в одной транзакции. При снятии выбора строка ОСТАЁТСЯ
 * с пустым значением: «администратор снял выбор» обязано перебивать старое место настроек,
 * иначе отправка снова ушла бы с ящика из настроек почты (проверено на живом стенде).
 *
 * @returns записанное значение (null — выбор снят).
 */
export async function setServiceAccountId(accountId: string | null, actor: Actor): Promise<string | null> {
  const value = String(accountId ?? "").trim() || null;
  const before = await getServiceAccountId();

  await getDocflowDb().transaction(async (tx) => {
    // Снятие выбора — тоже ЗАПИСЬ (пустое значение), а не удаление строки: см. выше.
    await tx
      .insert(settings)
      .values({ key: SERVICE_ACCOUNT_SETTING, value: value ?? "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: value ?? "" } });
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: "docflow.service_account",
      entityType: "settings",
      entityId: SERVICE_ACCOUNT_SETTING,
      oldValue: JSON.stringify({ accountId: before }),
      newValue: JSON.stringify({ accountId: value })
    });
  });

  return value;
}
