import type express from "express";
import { listAccounts, logger } from "@mailsense/core";
import {
  AppError,
  getServiceAccountState,
  setServiceAccountId,
  type Actor,
  type Permission
} from "@mailsense/docflow";
import { serviceAccountView } from "./serviceAccount.js";

/**
 * Служебный ящик отправки (Р12, task-11).
 *
 * Аппарат должен видеть, к какому ящику подключаться, не выспрашивая параметры голосом.
 * Поэтому параметры отдаются тем, у кого право `journal.register` (аппарат), а меняет
 * выбор администратор (`settings.manage`) — смена служебного ящика меняет, от чьего имени
 * уходят официальные письма, и её след пишется в аудит в той же транзакции.
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

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

export function mountServiceAccountRoutes(app: express.Express, deps: ServiceAccountDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const hint = [requireDocflowDb, requirePermission("journal.register")];
  const manage = [requireDocflowDb, requirePermission("settings.manage")];

  /** Параметры служебного ящика для аппарата: хост, порт, tls, логин. Без пароля. */
  app.get(
    "/api/docflow/service-account",
    ...hint,
    asyncHandler(async (_req, res) => {
      const accounts = listAccounts();
      // Единственный источник — настройки СЭД (старый ключ в настройках почты удалён).
      const state = await getServiceAccountState();
      const account = state.accountId ? accounts.find((a) => a.id === state.accountId) ?? null : null;
      const view = serviceAccountView(account, { configuredId: state.accountId });

      // Не молчим: именно молчание и привело к «письмо ушло не от того адреса».
      if (!state.accountId) {
        logger.warn({}, "Служебный ящик не задан — при отправке будет выбран первый ящик с настроенным SMTP");
      } else if (!account) {
        logger.warn({ accountId: state.accountId }, "Служебный ящик не найден среди ящиков предприятия");
      } else if (!account.smtpHost) {
        logger.warn({ accountId: state.accountId }, "У служебного ящика не настроен SMTP — отправлять нечем");
      }
      res.json(view);
    })
  );

  /** Смена служебного ящика: только администратор, с аудитом в той же транзакции. */
  app.put(
    "/api/docflow/service-account",
    ...manage,
    asyncHandler(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!("accountId" in b)) {
        // Молча снять выбор нельзя: «пустое тело» слишком легко получается случайно.
        throw new AppError(
          "Укажите accountId — идентификатор служебного ящика, либо null, чтобы снять выбор",
          400,
          "bad_account"
        );
      }
      if (b.accountId !== null && typeof b.accountId !== "string") {
        throw new AppError("accountId — строка или null", 400, "bad_account");
      }
      const accountId = b.accountId === null ? null : String(b.accountId).trim() || null;
      if (accountId && !listAccounts().some((a) => a.id === accountId)) {
        throw new AppError("Ящик не найден: " + accountId, 400, "unknown_account");
      }
      const saved = await setServiceAccountId(accountId, actorOf(req));
      res.json({ ok: true, accountId: saved });
    })
  );
}
