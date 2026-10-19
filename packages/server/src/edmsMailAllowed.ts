import { smtpReady, type SendAccountLike } from "./serviceAccount.js";

/**
 * Какие ящики работнику разрешены как «почта для СЭД» (Р24 + task-56).
 *
 * ⚠️ Почему выдача администратором, а не сверка логина: на стенде и в пилоте почта живёт
 * в домене @mail.test, а каталог — @stand.test (petrova_ma@mail.test против
 * Петрова_МА@stand.test). Строгая сверка адреса с логином заблокировала бы законный выбор.
 * Поэтому основной механизм — выдача, а совпадение логина с адресом ящика — удобное
 * дополнение (свой ящик не нужно выдавать отдельно).
 */
export interface AllowedMailbox {
  id: string;
  username: string;
  host: string;
  smtpReady: boolean;
  /** service — служебный ящик предприятия; personal — личный рабочий из выдачи. */
  kind: "service" | "personal";
}

export interface AllowedMailboxesInput {
  accounts: SendAccountLike[];
  /** Служебный внутренний ящик предприятия (docflow.serviceAccountId). */
  serviceId: string | null;
  /** АДРЕСА ящиков, выданные работнику администратором (идентификаторов админ не знает). */
  grantedAddresses: string[];
  /** Логины работника из каталога (email и логин) — для автодополнения. */
  workerLogins: Array<string | null | undefined>;
  /**
   * Адреса почтового сервера предприятия (умолчания почты: imap/pop3/smtp).
   * Пусто — предприятие адрес не задало, тогда принимаем любой СВОЙ ящик работника.
   */
  enterpriseHosts?: string[];
}

/** Логин для сравнения: регистр и краевые пробелы не важны. */
export function normalizeLogin(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Список разрешённых работнику ящиков.
 *
 * Порядок: служебный ящик предприятия, затем выданные/свои — так интерфейсу удобнее
 * показывать основной вариант первым. Ящик, который и служебный, и выданный, попадает
 * ОДНИМ пунктом с kind "service" (роль предприятия важнее личной выдачи).
 * ⚠️ Личные варианты (выданные и «свои» по логину) показываем НЕЗАВИСИМО от готовности SMTP
 * и честно отдаём smtpReady=false. Иначе выдача администратора выглядела бы успешной, а у
 * работника список оставался пустым без объяснения — живой дефект T58. Отказ переносится
 * на отправку: код smtp_not_configured (его интерфейс уже умеет объяснять).
 */
export function allowedMailboxes(input: AllowedMailboxesInput): AllowedMailbox[] {
  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const logins = new Set(input.workerLogins.map(normalizeLogin).filter(Boolean));
  const granted = new Set((Array.isArray(input.grantedAddresses) ? input.grantedAddresses : []).map(normalizeLogin).filter(Boolean));
  const out: AllowedMailbox[] = [];
  const seen = new Set<string>();
  // ⚠️ Заказчик: список адресов, который вёл администратор, — лишний шаг. Работник сам
  // выбирает СВОЙ ящик, единственное условие — он заведён на почтовом сервере предприятия.
  const enterprise = new Set((input.enterpriseHosts ?? []).map(normalizeLogin).filter(Boolean));
  const onEnterpriseServer = (account: SendAccountLike) =>
    enterprise.size === 0 ||
    enterprise.has(normalizeLogin(account.host)) ||
    enterprise.has(normalizeLogin(account.smtpHost));

  const ownOnEnterprise = (kind: AllowedMailbox["kind"]) => {
    for (const account of accounts) {
      if (seen.has(account.id)) continue;
      if (!onEnterpriseServer(account)) continue;
      seen.add(account.id);
      out.push(view(account, kind));
    }
  };

  const view = (account: SendAccountLike, kind: AllowedMailbox["kind"]): AllowedMailbox => ({
    id: account.id,
    username: account.username,
    host: account.host,
    smtpReady: smtpReady(account),
    kind
  });

  const service = input.serviceId ? byId.get(input.serviceId) : undefined;
  if (service) {
    out.push(view(service, "service"));
    seen.add(service.id);
  }

  // Свои ящики на сервере предприятия — основной вариант и без выдачи администратором:
  // идут сразу после служебного, чтобы первый личный пункт был предсказуем.
  ownOnEnterprise("personal");

  // Личный вариант — ящик САМОГО работника: его адрес выдан администратором или совпал
  // с логином из каталога. Чужие ящики в список не попадают: отправлять с них нельзя.
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    const address = normalizeLogin(account.username);
    if (granted.has(address) || logins.has(address)) {
      out.push(view(account, "personal"));
      seen.add(account.id);
    }
  }
  return out;
}

/** Разрешён ли ящик: по этому правилу проверяется и личный выбор, и отправка. */
export function isMailboxAllowed(allowed: AllowedMailbox[], accountId: string | null): boolean {
  const id = String(accountId ?? "").trim();
  return !!id && allowed.some((a) => a.id === id);
}
