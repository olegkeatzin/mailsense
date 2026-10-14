import type express from "express";
import { getAccountById, listAccounts, listAccountsForUser } from "@mailsense/core";
import {
  AppError,
  EDMS_WORK_ACCOUNT_SETTING,
  getAllowedWorkAccounts,
  getServiceAccountState,
  getUser,
  getUserSetting,
  normalizeWorkAddress,
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
  /** Выданные администратором АДРЕСА ящиков (без дублей) — то, что он и назначает. */
  addresses: string[];
  /**
   * Идентификаторы ящиков работника, попавших в выдачу. Оставлено для совместимости
   * с прежним экраном выдачи; источник правды — адреса.
   */
  accountIds: string[];
  /** Что работник может выбрать: служебный + выданные ему по адресу + свои по логину. */
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

    const [state, addresses] = await Promise.all([getServiceAccountState(), getAllowedWorkAccounts(userId)]);
    // Ящики БЕРЁМ У САМОГО РАБОТНИКА: администратор назначает адрес, а ящик с этим адресом
    // заводит работник своим паролем (docs/design/mail-ownership.md).
    const workerKey = String(user.ldapUid ?? "").trim() || user.id;
    const allowed = allowedMailboxes({
      accounts: listAccountsForUser(workerKey) as SendAccountLike[],
      serviceId: state.accountId,
      grantedAddresses: addresses,
      workerLogins: [user.email, user.ldapUid]
    });
    return {
      userId,
      addresses,
      accountIds: allowed.filter((a) => a.kind === "personal").map((a) => a.id),
      allowed,
      resetChoice
    };
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

      // Новый способ — адреса (их администратор и назначает). Прежний способ
      // (идентификаторы ящиков) принимаем и переводим в адреса: так старый экран не ломается.
      const requested: string[] = [];
      const push = (value: string) => {
        const address = normalizeWorkAddress(value);
        if (address && !requested.includes(address)) requested.push(address);
      };
      if (body.addresses !== undefined) {
        if (!Array.isArray(body.addresses)) {
          throw new AppError("addresses — список адресов ящиков", 400, "bad_addresses");
        }
        for (const raw of body.addresses) {
          if (typeof raw !== "string") throw new AppError("addresses — список строк", 400, "bad_addresses");
          const address = raw.trim();
          if (!address) continue;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
            throw new AppError("Не похоже на адрес ящика: " + raw, 400, "bad_address");
          }
          push(address);
        }
      } else if (Array.isArray(body.accountIds)) {
        const known = new Map((listAccounts() as SendAccountLike[]).map((a) => [a.id, a.username]));
        for (const raw of body.accountIds) {
          if (typeof raw !== "string") throw new AppError("accountIds — список строк", 400, "bad_accounts");
          const id = raw.trim();
          if (!id) continue;
          const username = known.get(id);
          if (!username) throw new AppError("Ящик не найден: " + id, 400, "unknown_account");
          push(username);
        }
      } else {
        throw new AppError("addresses — список адресов ящиков", 400, "bad_addresses");
      }

      // Адрес выбранного работником ящика нужен, чтобы решить, сбрасывать ли его выбор:
      // выдача хранит адреса, а выбор — идентификатор ящика.
      const [state, chosenId] = await Promise.all([
        getServiceAccountState(),
        getUserSetting(userId, EDMS_WORK_ACCOUNT_SETTING)
      ]);
      const chosen = chosenId ? getAccountById(chosenId) : null;
      const service = state.accountId ? getAccountById(state.accountId) : null;

      const result = await setAllowedWorkAccounts(userId, requested, actorOf(req), {
        chosenWorkAddress: chosen?.username ?? null,
        serviceAddress: service?.username ?? null
      });
      res.json(await payloadFor(userId, result.resetChoice));
    })
  );
}
