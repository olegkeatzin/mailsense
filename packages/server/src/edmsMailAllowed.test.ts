import { allowedMailboxes, isMailboxAllowed, normalizeLogin } from "./edmsMailAllowed.js";
import type { SendAccountLike } from "./serviceAccount.js";

/**
 * Правило «какие ящики работнику разрешены» (Р24 + task-56) и живой дефект T58.
 *
 * ⚠️ Главное, что здесь закреплено: ВЫДАННЫЙ ящик виден работнику ВСЕГДА — даже если у него
 * не настроен SMTP. Иначе выдача администратора выглядит успешной, а у работника список
 * пустой без объяснения (ровно это нашли живой проверкой). Про неготовность честно
 * сообщает флаг smtpReady, а отказывает уже отправка кодом smtp_not_configured.
 */
function account(over: Partial<SendAccountLike> = {}): SendAccountLike {
  return {
    id: "acc-1",
    protocol: "imap",
    host: "mail.test",
    port: 993,
    tls: "ssl",
    username: "test@mail.test",
    authType: "password",
    passwordEncrypted: "ШИФР",
    smtpHost: "mail.test",
    smtpPort: 465,
    smtpTls: "ssl",
    smtpUsername: "test@mail.test",
    smtpPasswordEncrypted: null,
    ...over
  } as SendAccountLike;
}

/** Ящик без SMTP: только входящая почта, отправить с него нельзя. */
const noSmtp = (over: Partial<SendAccountLike> = {}) =>
  account({ smtpHost: null, smtpPort: null, smtpTls: null, smtpUsername: null, smtpPasswordEncrypted: null, ...over });

describe("выданные ящики видны работнику всегда", () => {
  test("выданный ящик без SMTP: в списке, с честным smtpReady=false", () => {
    const granted = noSmtp({ id: "acc-granted", username: "petrova_ma@mail.test" });

    const allowed = allowedMailboxes({
      accounts: [account({ id: "acc-service", username: "post@mail.test" }), granted],
      serviceId: "acc-service",
      grantedAddresses: ["petrova_ma@mail.test"],
      workerLogins: []
    });

    expect(allowed).toEqual([
      { id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: true, kind: "service" },
      { id: "acc-granted", username: "petrova_ma@mail.test", host: "mail.test", smtpReady: false, kind: "personal" }
    ]);
    // Выбрать его можно: отказ будет на отправке, с понятным кодом.
    expect(isMailboxAllowed(allowed, "acc-granted")).toBe(true);
  });

  test("после настройки SMTP флаг становится true", () => {
    const allowed = allowedMailboxes({
      accounts: [account({ id: "acc-granted", username: "petrova_ma@mail.test" })],
      serviceId: null,
      grantedAddresses: ["petrova_ma@mail.test"],
      workerLogins: []
    });

    expect(allowed[0]).toMatchObject({ id: "acc-granted", smtpReady: true, kind: "personal" });
  });

  test("служебный ящик без SMTP тоже виден", () => {
    const allowed = allowedMailboxes({
      accounts: [noSmtp({ id: "acc-service", username: "post@mail.test" })],
      serviceId: "acc-service",
      grantedAddresses: [],
      workerLogins: []
    });

    expect(allowed).toEqual([
      { id: "acc-service", username: "post@mail.test", host: "mail.test", smtpReady: false, kind: "service" }
    ]);
  });

  test("свой ящик по логину — тоже независимо от готовности SMTP", () => {
    const allowed = allowedMailboxes({
      accounts: [noSmtp({ id: "acc-own", username: "ivanov@mail.test" })],
      serviceId: null,
      grantedAddresses: [],
      workerLogins: ["ivanov@mail.test"]
    });

    expect(allowed).toMatchObject([{ id: "acc-own", smtpReady: false, kind: "personal" }]);
  });
});

describe("список без дублей и без призраков", () => {
  test("ящик и служебный, и выданный — одним пунктом с kind service", () => {
    const allowed = allowedMailboxes({
      accounts: [account({ id: "acc-service" })],
      serviceId: "acc-service",
      grantedAddresses: ["post@mail.test"],
      workerLogins: ["test@mail.test"]
    });

    expect(allowed).toHaveLength(1);
    expect(allowed[0].kind).toBe("service");
  });

  test("выдача и совпадение логина на один ящик — тоже один пункт", () => {
    const allowed = allowedMailboxes({
      accounts: [account({ id: "acc-1", username: "ivanov@mail.test" })],
      serviceId: null,
      grantedAddresses: ["ivanov@mail.test", "ivanov@mail.test"],
      workerLogins: ["ivanov@mail.test", "  IVANOV@MAIL.TEST "]
    });

    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ id: "acc-1", kind: "personal" });
  });

  test("выданный, но исчезнувший ящик не попадает в список и не ломает остальные", () => {
    const allowed = allowedMailboxes({
      accounts: [account({ id: "acc-service" })],
      serviceId: "acc-service",
      grantedAddresses: ["ghost@mail.test"],
      workerLogins: []
    });

    expect(allowed.map((a) => a.id)).toEqual(["acc-service"]);
    expect(isMailboxAllowed(allowed, "acc-исчез")).toBe(false);
  });

  test("сравнение логинов не зависит от регистра и пробелов", () => {
    expect(normalizeLogin("  Ivanov@Mail.Test ")).toBe("ivanov@mail.test");
    expect(normalizeLogin(null)).toBe("");
  });
});
