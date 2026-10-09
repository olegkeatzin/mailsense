import type express from "express";
import { listAccounts } from "@mailsense/core";
import {
  AppError,
  getAllowedWorkAccounts,
  getServiceAccountState,
  getUser,
  setAllowedWorkAccounts,
  type Actor,
  type Permission
} from "@mailsense/docflow";
import { allowedMailboxes, type AllowedMailbox } from "./edmsMailAllowed.js";
import type { SendAccountLike } from "./serviceAccount.js";

/**
 * Выдача работнику ящиков «почты для СЭД» (task-56) — право settings.manage.
 *
 * Зачем выдача, а не сверка логина: на стенде почта в домене @mail.test, каталог в @stand.test.
 * Строгая сверка «адрес ящика = логин работника» заблокировала бы законный выбор, поэтому
 * решает администратор. Свой ящик, совпавший с логином, разрешён и без выдачи — как удобство.
 *
 * ⚠️ Отзыв ящика, который работник уже выбрал, СБРАСЫВАЕТ его выбор (делает docflow
 * в той же транзакции): иначе за работником осталось бы право отправлять с запрещённого.
 */
export interface EdmsAllowanceDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

export interface EdmsAllowancePayload {
  userId: string;
  /** Выданные администратором ящики (без дублей). */
  accountIds: string[];
  /** Что работник может выбрать: служебный + выданные + свои по логину. */
  allowed: AllowedMailbox[];
  /** Ящик, выбор которого сброшен этим отзывом; null — выбор не тронут. */
  resetChoice: string | null;
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

export function mountEdmsAllowanceRoutes(app: express.Express, deps: EdmsAllowanceDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const path = "/api/docflow/users/:userId/edms-mail-allowance";

  async function payloadFor(userId: string, resetChoice: string | null = null): Promise<EdmsAllowancePayload> {
    const user = await getUser(userId);
    if (!user) throw new AppError("Работник не найден: " + userId, 404, "user_not_found");

    const [state, accountIds] = await Promise.all([getServiceAccountState(), getAllowedWorkAccounts(userId)]);
    const allowed = allowedMailboxes({
      accounts: listAccounts() as SendAccountLike[],
      serviceId: state.accountId,
      grantedIds: accountIds,
      workerLogins: [user.email, user.ldapUid]
    });
    return { userId, accountIds, allowed, resetChoice };
  }

  app.get(
    path,
    requireDocflowDb,
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      res.json(await payloadFor(String(req.params.userId ?? "")));
    })
  );

  app.put(
    path,
    requireDocflowDb,
    requirePermission("settings.manage"),
    asyncHandler(async (req, res) => {
      const userId = String(req.params.userId ?? "");
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!Array.isArray(body.accountIds)) {
        throw new AppError("accountIds — список идентификаторов ящиков", 400, "bad_accounts");
      }
      if (body.accountIds.some((id) => typeof id !== "string")) {
        throw new AppError("accountIds — список строк", 400, "bad_accounts");
      }

      // Дубликаты схлопываем: один ящик выдаётся один раз.
      const requested: string[] = [];
      for (const raw of body.accountIds as string[]) {
        const id = raw.trim();
        if (id && !requested.includes(id)) requested.push(id);
      }

      // Несуществующие ящики — 400: выдать то, чего нет, нельзя.
      const known = new Set((listAccounts() as SendAccountLike[]).map((a) => a.id));
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length) {
        throw new AppError("Ящик не найден: " + unknown.join(", "), 400, "unknown_account");
      }

      const result = await setAllowedWorkAccounts(userId, requested, actorOf(req));
      res.json(await payloadFor(userId, result.resetChoice));
    })
  );
}
