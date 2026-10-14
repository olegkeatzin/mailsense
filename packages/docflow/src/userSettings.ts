import { and, eq } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { auditInTx } from "./audit.js";
import type { Actor } from "./journal.js";
import { getServiceAccountId } from "./serviceAccount.js";

/**
 * Личные настройки работника в СЭД (Р24, task-51).
 *
 * Первый ключ — «почта для СЭД» (`edms.workAccountId`): работник выбирает, с какого ящика
 * уходят официальные письма по его поручениям. Настройка личная, но лежит на СЕРВЕРЕ:
 * от неё зависит выбор ящика отправки, а это решение предприятия, а не рабочего места.
 *
 * ⚠️ Запись и след аудита — ОДНА транзакция (AGENTS.md, п. 4): смена «почты для СЭД»
 * меняет, от чьего адреса уйдёт официальное письмо, и след не должен потеряться при сбое.
 */
const { userSettings } = docflowSchema;

/** Ключ личной настройки: ящик работника для СЭД. */
export const EDMS_WORK_ACCOUNT_SETTING = "edms.workAccountId";
/** Действие аудита при смене личной почты СЭД. */
export const EDMS_WORK_MAIL_AUDIT_ACTION = "edms.work_mail";
/**
 * Ключ выдачи: какие АДРЕСА ящиков администратор разрешил работнику как «почту для СЭД»
 * (адреса через запятую, регистр не важен).
 *
 * ⚠️ Храним именно АДРЕС, а не идентификатор ящика: администратор не знает ящиков
 * работника и не должен вводить его пароль — он назначает адрес (по умолчанию из LDAP),
 * а пароль работник вводит сам (docs/design/mail-ownership.md).
 */
export const EDMS_ALLOWED_WORK_ACCOUNTS_SETTING = "edms.allowedWorkMails";
/** Действие аудита при выдаче/отзыве ящиков работнику. */
export const EDMS_WORK_MAIL_ALLOWANCE_AUDIT_ACTION = "edms.work_mail_allowance";

/** Значение личной настройки; null — настройки нет (или выбор снят). */
export async function getUserSetting(userId: string, key: string): Promise<string | null> {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  const rows = await getDocflowDb()
    .select()
    .from(userSettings)
    .where(and(eq(userSettings.userId, id), eq(userSettings.key, key)))
    .limit(1);
  const value = rows[0]?.value ?? null;
  return value === null || value.trim() === "" ? null : value;
}

/** Все личные настройки пользователя (для ответа API). */
export async function listUserSettings(userId: string): Promise<Record<string, string>> {
  const id = String(userId ?? "").trim();
  if (!id) return {};
  const out: Record<string, string> = {};
  for (const row of await getDocflowDb().select().from(userSettings).where(eq(userSettings.userId, id))) {
    if (row.value.trim() !== "") out[row.key] = row.value;
  }
  return out;
}

/**
 * Записывает личную настройку; null — снимает выбор (строку удаляем).
 *
 * След аудита пишется в ТОЙ ЖЕ транзакции: в entity_id — идентификатор работника
 * (настройка его личная), в было/стало — значения ключа.
 */
export async function setUserSetting(
  userId: string,
  key: string,
  value: string | null,
  actor: Actor,
  auditAction: string
): Promise<string | null> {
  const id = String(userId ?? "").trim();
  if (!id) throw new Error("Не указан работник");
  const normalized = value === null || String(value).trim() === "" ? null : String(value).trim();

  return getDocflowDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, id), eq(userSettings.key, key)))
      .limit(1);
    const before = rows[0]?.value ?? null;
    const beforeValue = before && before.trim() !== "" ? before : null;

    if (normalized === null) {
      if (rows.length) {
        await tx.delete(userSettings).where(and(eq(userSettings.userId, id), eq(userSettings.key, key)));
      }
    } else {
      await tx
        .insert(userSettings)
        .values({ userId: id, key, value: normalized, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.key],
          set: { value: normalized, updatedAt: new Date() }
        });
    }

    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: auditAction,
      entityType: "user",
      entityId: id,
      oldValue: JSON.stringify({ [key]: beforeValue }),
      newValue: JSON.stringify({ [key]: normalized })
    });
    return normalized;
  });
}

/** Адрес ящика для сравнения: регистр и краевые пробелы не важны. */
export function normalizeWorkAddress(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Список адресов из строки настройки: через запятую, без пустых и дублей. */
export function parseWorkAddressList(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(value ?? "").split(",")) {
    const address = normalizeWorkAddress(part);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

/** Выданные работнику адреса ящиков (пустой список — ничего не выдано). */
export async function getAllowedWorkAccounts(userId: string): Promise<string[]> {
  return parseWorkAddressList(await getUserSetting(userId, EDMS_ALLOWED_WORK_ACCOUNTS_SETTING));
}

/** Что нужно знать, чтобы решить, сбрасывать ли выбор работника при отзыве. */
export interface AllowanceContext {
  /** Адрес ящика, который работник выбрал сейчас (резолвит сервер); null — не разрешился. */
  chosenWorkAddress?: string | null;
  /** Адрес служебного ящика предприятия: он разрешён всегда, его отзыв выбора не касается. */
  serviceAddress?: string | null;
}

export interface AllowanceResult {
  /** Итоговый список выданных АДРЕСОВ ящиков. */
  addresses: string[];
  /** Выбор, сброшенный отзывом (ящик больше не разрешён); null — выбор не тронут. */
  resetChoice: string | null;
}

/**
 * Выдача/отзыв ящиков работнику (task-56).
 *
 * ⚠️ Отзыв ящика, который работник уже выбрал рабочим, СБРАСЫВАЕТ выбор — иначе за ним
 * осталось бы право отправлять с ящика, который администратор только что запретил.
 * Выдача, сброс выбора и оба следа аудита — ОДНА транзакция: «наполовину отозвали»
 * состояние недопустимо.
 */
export async function setAllowedWorkAccounts(
  userId: string,
  addresses: string[],
  actor: Actor,
  context: AllowanceContext = {}
): Promise<AllowanceResult> {
  const id = String(userId ?? "").trim();
  if (!id) throw new Error("Не указан работник");
  const next = parseWorkAddressList(Array.isArray(addresses) ? addresses.join(",") : "");

  return getDocflowDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, id), eq(userSettings.key, EDMS_ALLOWED_WORK_ACCOUNTS_SETTING)))
      .limit(1);
    const before = parseWorkAddressList(rows[0]?.value ?? null);

    if (next.length === 0) {
      if (rows.length) {
        await tx
          .delete(userSettings)
          .where(and(eq(userSettings.userId, id), eq(userSettings.key, EDMS_ALLOWED_WORK_ACCOUNTS_SETTING)));
      }
    } else {
      await tx
        .insert(userSettings)
        .values({ userId: id, key: EDMS_ALLOWED_WORK_ACCOUNTS_SETTING, value: next.join(","), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.key],
          set: { value: next.join(","), updatedAt: new Date() }
        });
    }

    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: EDMS_WORK_MAIL_ALLOWANCE_AUDIT_ACTION,
      entityType: "user",
      entityId: id,
      oldValue: JSON.stringify({ [EDMS_ALLOWED_WORK_ACCOUNTS_SETTING]: before }),
      newValue: JSON.stringify({ [EDMS_ALLOWED_WORK_ACCOUNTS_SETTING]: next })
    });

    // Отзыв: выбранный ящик обязан остаться разрешённым. Сравниваем АДРЕСА: выдача хранит
    // адрес, а выбор работника — идентификатор ящика, поэтому адрес выбранного ящика
    // передаёт сервер (у docflow нет почтового ядра). Служебный ящик предприятия разрешён
    // всегда, поэтому его отзыв выбора не касается.
    await getServiceAccountId(tx);
    const chosenRows = await tx
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, id), eq(userSettings.key, EDMS_WORK_ACCOUNT_SETTING)))
      .limit(1);
    const chosen = chosenRows[0]?.value?.trim() || null;
    const chosenAddress = normalizeWorkAddress(context.chosenWorkAddress);
    const serviceAddress = normalizeWorkAddress(context.serviceAddress);
    const stillAllowed =
      !!chosenAddress && (next.includes(chosenAddress) || chosenAddress === serviceAddress);
    let resetChoice: string | null = null;
    if (chosen && !stillAllowed) {
      await tx
        .delete(userSettings)
        .where(and(eq(userSettings.userId, id), eq(userSettings.key, EDMS_WORK_ACCOUNT_SETTING)));
      await auditInTx(tx, {
        userId: actor.id,
        userName: actor.name,
        action: EDMS_WORK_MAIL_AUDIT_ACTION,
        entityType: "user",
        entityId: id,
        oldValue: JSON.stringify({ [EDMS_WORK_ACCOUNT_SETTING]: chosen }),
        newValue: JSON.stringify({ [EDMS_WORK_ACCOUNT_SETTING]: null })
      });
      resetChoice = chosen;
    }

    return { addresses: next, resetChoice };
  });
}
