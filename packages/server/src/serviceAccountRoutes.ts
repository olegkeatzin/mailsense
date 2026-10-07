import type express from "express";
import { listAccounts, logger } from "@mailsense/core";
import {
  AppError,
  getExternalAccountState,
  getServiceAccountState,
  setServiceAccounts,
  type Actor,
  type Permission,
  type ServiceAccountState
} from "@mailsense/docflow";
import { serviceAccountView, type ServiceAccountView } from "./serviceAccount.js";

/**
 * Служебные почты СЭД (Р12/T11 и Р16/T25): внутренняя делопроизводства и внешняя приёмная.
 *
 * Аппарат должен видеть, к каким ящикам подключаться, не выспрашивая параметры голосом.
 * Поэтому параметры отдаются тем, у кого право `journal.register` (аппарат), а меняет
 * выбор администратор (`settings.manage`) — смена служебной почты меняет, от чьего имени
 * уходят официальные письма, и её след пишется в аудит в той же транзакции.
 *
 * Совместимость: прежние поля ответа (`configured`, `account`, `problem`, `problemCode`)
 * по-прежнему описывают ВНУТРЕННЮЮ почту, а `accountId` в PUT её же и меняет — старый клиент
 * работает как раньше. Внешняя приёмная добавлена отдельным блоком `incoming`.
 *
 * ⚠️ Пароли не отдаются НИКОГДА: ответ собирается поимённо, а не spreading записи ящика.
 */
export interface ServiceAccountDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

/** Ответ маршрута: прежний контракт внутренней почты + блок внешней приёмной. */
export interface ServiceAccountsPayload extends ServiceAccountView {
  /** Внешняя приёмная почта (Р16): куда приходит внешняя корреспонденция. */
  incoming: ServiceAccountView;
  /** Обе роли назначены на один ящик (пилот) — не запрет, но требует внимания. */
  sameAccount: boolean;
  /** Текст предупреждения к sameAccount; null — предупреждать не о чем. */
  notice: string | null;
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

const SAME_ACCOUNT_NOTICE =
  "Обе роли назначены на один и тот же ящик (пилот): и ответы контрагентам, и письма руководителю " +
  "уйдут с одного адреса. Для боевой работы выберите внешнюю приёмную почту отдельно.";

/** Значение из тела запроса: есть ли поле, и что в нём (строка или null). */
function readField(body: Record<string, unknown>, field: string): { present: boolean; value: string | null } {
  if (!(field in body)) return { present: false, value: null };
  const raw = body[field];
  if (raw === null) return { present: true, value: null };
  if (typeof raw !== "string") {
    throw new AppError(field + " — строка или null", 400, "bad_account");
  }
  return { present: true, value: raw.trim() || null };
}

/**
 * Текущее состояние обеих ролей одним ответом.
 *
 * Роли независимы: у каждой свой признак `configured`, свои параметры и своя причина, если
 * выбрать нельзя. Одинаковые ящики разрешены — про это говорит `sameAccount`.
 */
async function serviceAccountsPayload(): Promise<ServiceAccountsPayload> {
  const accounts = listAccounts();
  const [internalState, externalState] = await Promise.all([
    getServiceAccountState(),
    getExternalAccountState()
  ]);

  const viewFor = (state: ServiceAccountState, role: string, requiresSmtp: boolean): ServiceAccountView => {
    const account = state.accountId ? accounts.find((a) => a.id === state.accountId) ?? null : null;
    // Не молчим: именно молчание и приводило к «письмо ушло не от того адреса».
    if (!state.accountId) {
      logger.warn(
        { role },
        "Служебная почта не задана (" + role + ") — соответствующая роль работать не будет"
      );
    } else if (!account) {
      logger.warn({ role, accountId: state.accountId }, "Служебная почта не найдена среди ящиков (" + role + ")");
    } else if (requiresSmtp && !account.smtpHost) {
      logger.warn({ role, accountId: state.accountId }, "У служебной почты не настроен SMTP (" + role + ")");
    }
    return serviceAccountView(account, { configuredId: state.accountId, requiresSmtp });
  };

  // Внутренняя роль ОТПРАВЛЯЕТ (SMTP обязателен), внешняя приёмная только принимает.
  const internal = viewFor(internalState, "внутренняя делопроизводства", true);
  const incoming = viewFor(externalState, "внешняя приёмная", false);
  const sameAccount = !!internalState.accountId && internalState.accountId === externalState.accountId;

  return {
    // Прежние поля — про внутреннюю почту: контракт T11 не менялся.
    ...internal,
    incoming,
    sameAccount,
    notice: sameAccount ? SAME_ACCOUNT_NOTICE : null
  };
}

export function mountServiceAccountRoutes(app: express.Express, deps: ServiceAccountDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const hint = [requireDocflowDb, requirePermission("journal.register")];
  const manage = [requireDocflowDb, requirePermission("settings.manage")];

  /** Параметры служебных почт для аппарата: хост, порт, tls, логин. Без пароля. */
  app.get(
    "/api/docflow/service-account",
    ...hint,
    asyncHandler(async (_req, res) => {
      res.json(await serviceAccountsPayload());
    })
  );

  /** Смена служебных почт: только администратор, аудит по каждой роли в той же транзакции. */
  app.put(
    "/api/docflow/service-account",
    ...manage,
    asyncHandler(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      // Совместимость: accountId — внутренняя почта (как было), incomingAccountId — внешняя приёмная.
      const internal = readField(b, "accountId");
      const external = readField(b, "incomingAccountId");
      if (!internal.present && !external.present) {
        // Молча ничего не снимаем: «пустое тело» слишком легко получается случайно.
        throw new AppError(
          "Укажите accountId (внутренняя почта) и/или incomingAccountId (внешняя приёмная), " +
            "либо null, чтобы снять выбор",
          400,
          "bad_account"
        );
      }

      const accounts = listAccounts();
      if (internal.value && !accounts.some((a) => a.id === internal.value)) {
        throw new AppError("Ящик для отправки не найден: " + internal.value, 400, "unknown_account");
      }
      if (external.value && !accounts.some((a) => a.id === external.value)) {
        throw new AppError("Внешняя приёмная почта не найдена: " + external.value, 400, "unknown_account");
      }

      const pair = await setServiceAccounts(
        {
          ...(internal.present ? { internal: internal.value } : {}),
          ...(external.present ? { external: external.value } : {})
        },
        actorOf(req)
      );

      res.json({
        ok: true,
        accountId: pair.internal,
        incomingAccountId: pair.external,
        // Тот же shape, что у GET: клиенту не нужно перечитывать состояние отдельным запросом.
        ...(await serviceAccountsPayload())
      });
    })
  );
}
