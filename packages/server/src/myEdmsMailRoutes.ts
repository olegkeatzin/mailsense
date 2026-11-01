import type express from "express";
import { getAccount, listAccountsForUser } from "@mailsense/core";
import {
  AppError,
  EDMS_WORK_ACCOUNT_SETTING,
  EDMS_WORK_MAIL_AUDIT_ACTION,
  getAllowedWorkAccounts,
  getServiceAccountState,
  getUserSetting,
  setUserSetting,
  type Actor
} from "@mailsense/docflow";
import { allowedMailboxes, isMailboxAllowed, type AllowedMailbox } from "./edmsMailAllowed.js";
import { selectSendAccount, smtpReady, type SendAccountLike } from "./serviceAccount.js";

/**
 * «Почта для СЭД» — личный выбор работника (Р24; task-51, task-56).
 *
 * Работник выбирает, с какого ящика уходят официальные письма по его поручениям.
 * Доступно ЛЮБОМУ вошедшему и только за СЕБЯ: идентификатор берётся из сессии.
 *
 * ⚠️ Выбирать можно ТОЛЬКО из разрешённых (task-56): служебный ящик предприятия и ящики,
 * выданные администратором (плюс свой ящик, если его адрес совпал с логином работника).
 * Иначе работник мог бы назвать «своей рабочей почтой» ящик директора и отправлять с него.
 */
export interface MyEdmsMailDeps {
  requireDocflowDb: express.RequestHandler;
  /** Адреса почтового сервера предприятия (из умолчаний почты) — условие выбора ящика. */
  enterpriseHosts: () => Promise<string[]>;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

export interface MyEdmsMailAccount {
  id: string;
  username: string;
  host: string;
  smtpReady: boolean;
}

export interface MyEdmsMailPayload {
  /** Личный выбор работника; null — не выбран. */
  accountId: string | null;
  /** Запись выбранного ящика; null — выбора нет или ящик исчез. */
  account: MyEdmsMailAccount | null;
  /** Разрешённые ящики: служебный внутренний + выданные (и свой по логину). */
  allowed: AllowedMailbox[];
  /** С какого ящика уйдёт письмо, если ящик не указать явно (приоритет Р24). */
  defaultAccountId: string | null;
}

function accountView(account: SendAccountLike): MyEdmsMailAccount {
  return { id: account.id, username: account.username, host: account.host, smtpReady: smtpReady(account) };
}

function actorOf(req: express.Request): Actor {
  return { id: req.user?.id ?? null, name: req.user?.fullName ?? "" };
}

/** Работник — только из сессии: ни тело, ни параметры на это не влияют. */
function workerIdOf(req: express.Request): string {
  if (!req.user) throw new AppError("Требуется вход в систему", 401, "unauthorized");
  return req.user.id;
}

/** Логины работника для автодополнения: адрес из каталога и логин. */
function workerLogins(req: express.Request): string[] {
  const user = req.user as { email?: string | null; ldapUid?: string | null } | null;
  return [user?.email ?? null, user?.ldapUid ?? null].filter((v): v is string => !!v);
}

/**
 * Владелец ящиков работника — его LDAP-логин (у локального администратора — id).
 * Ящики берём только СВОИ: отправлять с чужого нельзя (docs/design/mail-ownership.md).
 */
function workerOwnerKey(req: express.Request): string {
  const user = req.user as { id?: string; ldapUid?: string | null } | null;
  const login = String(user?.ldapUid ?? "").trim();
  return login || String(user?.id ?? "").trim();
}

interface Worker {
  id: string;
  logins: string[];
  ownerKey: string;
}

export function mountMyEdmsMailRoutes(app: express.Express, deps: MyEdmsMailDeps): void {
  const { requireDocflowDb, asyncHandler, enterpriseHosts } = deps;

  /**
   * Ящики, которые работник вправе видеть в списке: его собственные плюс служебный.
   *
   * ⚠️ Служебный ящик почти всегда принадлежит другому владельцу (или никому), поэтому
   * listAccountsForUser его не возвращает. Без явного добавления getServiceAccountState
   * сообщал «ящик задан», а список оставался пустым — интерфейс требовал выбрать ящик,
   * которого не было в options.
   */
  function selectableAccounts(worker: Worker, serviceId: string | null): SendAccountLike[] {
    const own = listAccountsForUser(worker.ownerKey) as SendAccountLike[];
    if (!serviceId || own.some((a) => a.id === serviceId)) return own;
    const service = getAccount(serviceId) as SendAccountLike | null;
    return service ? [...own, service] : own;
  }

  async function allowedFor(worker: Worker, serviceId?: string | null): Promise<AllowedMailbox[]> {
    const state = serviceId === undefined ? await getServiceAccountState() : { accountId: serviceId };
    const grantedAddresses = await getAllowedWorkAccounts(worker.id);
    return allowedMailboxes({
      accounts: selectableAccounts(worker, state.accountId),
      serviceId: state.accountId,
      grantedAddresses,
      workerLogins: worker.logins,
      enterpriseHosts: await enterpriseHosts()
    });
  }

  async function payloadFor(worker: Worker): Promise<MyEdmsMailPayload> {
    const state = await getServiceAccountState();
    const accounts = selectableAccounts(worker, state.accountId);
    const [personalId, allowed] = await Promise.all([
      getUserSetting(worker.id, EDMS_WORK_ACCOUNT_SETTING),
      allowedFor(worker, state.accountId)
    ]);
    const personal = personalId ? accounts.find((a) => a.id === personalId) ?? null : null;

    // С какого ящика уйдёт письмо, если не указывать явно: личный рабочий, иначе служебный.
    const selection = selectSendAccount(accounts, {
      personalId,
      configuredId: state.accountId,
      cleared: state.explicit && state.accountId === null,
      allowedIds: [personalId, state.accountId].filter((id): id is string => !!id)
    });

    return {
      accountId: personalId,
      account: personal ? accountView(personal) : null,
      allowed,
      defaultAccountId: selection.account?.id ?? null
    };
  }

  app.get(
    "/api/docflow/my-edms-mail",
    requireDocflowDb,
    asyncHandler(async (req, res) => {
      const worker: Worker = { id: workerIdOf(req), logins: workerLogins(req), ownerKey: workerOwnerKey(req) };
      res.json(await payloadFor(worker));
    })
  );

  app.put(
    "/api/docflow/my-edms-mail",
    requireDocflowDb,
    asyncHandler(async (req, res) => {
      const worker: Worker = { id: workerIdOf(req), logins: workerLogins(req), ownerKey: workerOwnerKey(req) };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body.accountId;
      if (raw !== null && raw !== undefined && typeof raw !== "string") {
        throw new AppError("accountId — строка или null", 400, "bad_account");
      }
      const accountId = typeof raw === "string" ? raw.trim() || null : null;

      // ⚠️ Выбирать можно только из разрешённых: само существование ящика — НЕ аргумент.
      if (accountId) {
        const allowed = await allowedFor(worker);
        if (!isMailboxAllowed(allowed, accountId)) {
          throw new AppError(
            "С этого ящика отправлять нельзя: выберите свой ящик на почтовом сервере " +
              "предприятия (или служебный ящик предприятия).",
            403,
            "account_not_allowed"
          );
        }
      }

      await setUserSetting(worker.id, EDMS_WORK_ACCOUNT_SETTING, accountId, actorOf(req), EDMS_WORK_MAIL_AUDIT_ACTION);
      res.json(await payloadFor(worker));
    })
  );
}
