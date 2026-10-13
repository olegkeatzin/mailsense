import { classifyAdError, ldapFailureMessage, loginToSam, buildBindIdentifier } from "./ldap.js";
import type { LdapSettings } from "../types.js";

const S: LdapSettings = { url: "ldaps://dc.test:636", baseDn: "OU=KNIITMU,DC=stand,DC=test", loginFormat: "upn", upnSuffix: "@stand.test" };

describe("классификация отказов Active Directory", () => {
  // Реальные ответы AD: человекочитаемой причины нет, только «data XXX».
  const cases: [string, string][] = [
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1", "invalid_credentials"],
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 525, v1db1", "invalid_credentials"],
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 532, v1db1", "password_expired"],
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 533, v1db1", "account_disabled"],
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 701, v1db1", "account_expired"],
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 775, v1db1", "account_locked"],
    ["Invalid credentials (49)", "invalid_credentials"],
    // Контроллер требует защищённого соединения: простой bind по ldap:// отклонён.
    ["80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 8, v1db1", "strong_auth"],
    ["Strong(er) authentication required", "strong_auth"],
    ["connect ECONNREFUSED 127.0.0.1:636", "network"]
  ];

  test.each(cases)("%s -> %s", (message, expected) => {
    expect(classifyAdError(message)).toBe(expected);
  });

  test("каждой причине соответствует понятный текст без внутренних деталей", () => {
    expect(ldapFailureMessage("invalid_credentials")).toBe("Неверный логин или пароль");
    expect(ldapFailureMessage("account_locked")).toMatch(/заблокирована/);
    // Наружу не должны попадать коды AD и имена DSID.
    for (const kind of ["invalid_credentials", "password_expired", "account_disabled", "account_locked", "account_expired", "strong_auth", "config", "not_found", "network", "unknown"] as const) {
      expect(ldapFailureMessage(kind)).not.toMatch(/data\s|DSID|0x[0-9a-f]+|\b52e\b/i);
    }
    // Неизвестную ошибку больше НЕ выдаём за неверный пароль: это сбивало с толку на приёмке.
    expect(ldapFailureMessage("unknown")).toContain("журнал сервера");
    expect(classifyAdError("unwilling to perform")).toBe("unknown");
    expect(ldapFailureMessage("strong_auth")).toMatch(/ldaps|636/);
  });
});

describe("приведение логина", () => {
  test("UPN, домен и голый логин дают sAMAccountName", () => {
    expect(loginToSam("test@stand.test", S)).toBe("test");
    expect(loginToSam("STAND\\test", S)).toBe("test");
    expect(loginToSam("test", S)).toBe("test");
    expect(loginToSam("Иванов_ИИ", S)).toBe("Иванов_ИИ");
  });

  test("готовый DN не разбирается", () => {
    const dn = "CN=Иван Иванов,OU=KNIITMU,DC=stand,DC=test";
    expect(loginToSam(dn, S)).toBe(dn);
  });

  test("bind-строка собирается по UPN без дублирования @", () => {
    expect(buildBindIdentifier("test", S)).toBe("test@stand.test");
    expect(buildBindIdentifier("test@stand.test", S)).toBe("test@stand.test");
    expect(buildBindIdentifier("test", { ...S, upnSuffix: "stand.test" })).toBe("test@stand.test");
  });
});
