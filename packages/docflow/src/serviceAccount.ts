/**
 * Служебные почты СЭД (Р16, T25): внешняя приёмная и внутренняя делопроизводства.
 *
 * • внутренняя (`docflow.serviceAccountId`) — с неё уходит письмо руководителю и исполнителям;
 * • внешняя (`docflow.externalAccountId`) — куда приходит внешняя почта; ответ контрагенту
 *   уходит с ящика получения (правило почтового композера, а не серверной подстановки).
 *
 * ⚠️ Смена служебной почты меняет, ОТ ЧЬЕГО ИМЕНИ уходят официальные письма. Поэтому запись
 * настройки и след аудита — одна транзакция (AGENTS.md, п. 4), и на каждую изменённую роль
 * пишется своя строка следа.
 */
import { eq } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import type { DocflowExecutor } from "./repo.js";
import { auditInTx } from "./audit.js";
import type { Actor } from "./journal.js";

const { settings } = docflowSchema;

/** Внутренняя почта: из неё уходит письмо руководителю и исполнителям. */
export const SERVICE_ACCOUNT_SETTING = "docflow.serviceAccountId";
/** Внешняя приёмная почта: куда приходит внешняя корреспонденция. */
export const EXTERNAL_ACCOUNT_SETTING = "docflow.externalAccountId";

export interface ServiceAccountState {
  /**
   * Строка настройки существует — администратор выбор делал (в том числе ЯВНО снял его).
   * Это отличает «ещё не настроено» от «настроено и снято»: иначе «снять ящик» не отключало бы
   * отправку и настройка выглядела бы незаданной.
   */
  explicit: boolean;
  accountId: string | null;
}

/** Значение роли: пустая строка и null одинаково означают «снять выбор». */
function normalize(accountId: string | null | undefined): string | null {
  return String(accountId ?? "").trim() || null;
}

async function readState(exec: DocflowExecutor | undefined, key: string): Promise<ServiceAccountState> {
  const db = exec ?? getDocflowDb();
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (rows.length === 0) return { explicit: false, accountId: null };
  const value = (rows[0].value ?? "").trim();
  return { explicit: true, accountId: value === "" ? null : value };
}

/** Состояние внутренней роли (с неё уходит поручение и письмо руководителю). */
export async function getServiceAccountState(exec?: DocflowExecutor): Promise<ServiceAccountState> {
  return readState(exec, SERVICE_ACCOUNT_SETTING);
}

/** Состояние внешней приёмной роли. */
export async function getExternalAccountState(exec?: DocflowExecutor): Promise<ServiceAccountState> {
  return readState(exec, EXTERNAL_ACCOUNT_SETTING);
}

/** Выбранный внутренний ящик; null — не задан или выбор снят. */
export async function getServiceAccountId(exec?: DocflowExecutor): Promise<string | null> {
  return (await getServiceAccountState(exec)).accountId;
}

/** Выбранный внешний приёмный ящик; null — не задан или выбор снят. */
export async function getExternalAccountId(exec?: DocflowExecutor): Promise<string | null> {
  return (await getExternalAccountState(exec)).accountId;
}

export interface ServiceAccountPair {
  internal: string | null;
  external: string | null;
}

export interface ServiceAccountsInput {
  /** Внутренняя роль; undefined — не трогаем, null — снять выбор. */
  internal?: string | null;
  /** Внешняя приёмная роль; undefined — не трогаем, null — снять выбор. */
  external?: string | null;
}

async function writeSetting(exec: DocflowExecutor, key: string, value: string | null): Promise<void> {
  // Снятие выбора — тоже ЗАПИСЬ (пустое значение), а не удаление строки: «администратор снял
  // выбор» обязано отличаться от «ещё не настраивали», иначе вернётся прежнее поведение.
  await exec
    .insert(settings)
    .values({ key, value: value ?? "" })
    .onConflictDoUpdate({ target: settings.key, set: { value: value ?? "" } });
}

/**
 * Записывает выбранные роли ОДНОЙ транзакцией.
 *
 * На каждую изменённую роль пишется своя строка аудита: в entityId — ключ настройки, так
 * видно, какую именно роль меняли. Роли, которые не переданы (undefined), не трогаются
 * вовсе, и следа по ним не появляется.
 */
export async function setServiceAccounts(input: ServiceAccountsInput, actor: Actor): Promise<ServiceAccountPair> {
  const internal = input.internal === undefined ? undefined : normalize(input.internal);
  const external = input.external === undefined ? undefined : normalize(input.external);

  await getDocflowDb().transaction(async (tx) => {
    // ⚠️ Аудит — журнал ИЗМЕНЕНИЙ, а не вызовов. Повторная запись того же значения события
    // не создаёт: иначе в следе появляется «d45c… → d45c…», и по нему нельзя понять, меняли
    // ли настройку вообще. Найдено живой проверкой T25 на стенде.
    if (internal !== undefined) {
      const before = await readState(tx, SERVICE_ACCOUNT_SETTING);
      if (!before.explicit || before.accountId !== internal) {
        await writeSetting(tx, SERVICE_ACCOUNT_SETTING, internal);
        await auditInTx(tx, {
          userId: actor.id,
          userName: actor.name,
          action: "docflow.service_account",
          entityType: "settings",
          entityId: SERVICE_ACCOUNT_SETTING,
          oldValue: JSON.stringify({ accountId: before.accountId }),
          newValue: JSON.stringify({ accountId: internal })
        });
      }
    }
    if (external !== undefined) {
      const before = await readState(tx, EXTERNAL_ACCOUNT_SETTING);
      if (!before.explicit || before.accountId !== external) {
        await writeSetting(tx, EXTERNAL_ACCOUNT_SETTING, external);
        await auditInTx(tx, {
          userId: actor.id,
          userName: actor.name,
          action: "docflow.service_account",
          entityType: "settings",
          entityId: EXTERNAL_ACCOUNT_SETTING,
          oldValue: JSON.stringify({ accountId: before.accountId }),
          newValue: JSON.stringify({ accountId: external })
        });
      }
    }
  });

  return { internal: await getServiceAccountId(), external: await getExternalAccountId() };
}

/**
 * Задать внутреннюю служебную почту (null — снять выбор).
 *
 * Тонкая обёртка над парной операцией: транзакционная логика у обеих ролей одна и та же,
 * а прежние вызывающие (и тесты) продолжают работать с одиночной функцией.
 */
export async function setServiceAccountId(accountId: string | null, actor: Actor): Promise<string | null> {
  const result = await setServiceAccounts({ internal: accountId }, actor);
  return result.internal;
}
