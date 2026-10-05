/**
 * Каталог LDAP/AD. Два критичных места: классификация отказов Active Directory
 * (пользователь должен видеть причину, а не дамп AcceptSecurityContext) и экранирование
 * значений фильтра (иначе логин со звёздочкой ломает запрос целиком).
 */
const mockBind = jest.fn();
const mockSearch = jest.fn();
const mockUnbind = jest.fn();
const mockClientCtor = jest.fn();

jest.mock("ldapts", () => ({
  __esModule: true,
  Client: function (opts: unknown) {
    mockClientCtor(opts);
    return { bind: mockBind, search: mockSearch, unbind: mockUnbind };
  }
}));

import {
  buildBindIdentifier,
  classifyAdError,
  ldapAuthenticate,
  ldapFailureMessage,
  ldapListProfiles,
  ldapSearchContacts,
  LdapError,
  loginToSam,
  verifyLdapCredentials
} from "./ldap.js";
import type { LdapSettings } from "../types.js";

function settings(over: Partial<LdapSettings> = {}): LdapSettings {
  return {
    enabled: true,
    url: "ldaps://dc.test:636",
    baseDn: "OU=KNIITMU,DC=test",
    loginFormat: "upn",
    upnSuffix: "@test.local",
    netbiosDomain: "TEST",
    userFilter: "",
    attributes: [],
    sizeLimit: 25,
    rejectUnauthorized: false,
    ...over
  };
}

beforeEach(() => {
  mockBind.mockReset().mockResolvedValue(undefined);
  mockSearch.mockReset().mockResolvedValue({ searchEntries: [] });
  mockUnbind.mockReset().mockResolvedValue(undefined);
  mockClientCtor.mockReset();
});

describe("разбор отказов Active Directory", () => {
  test("неверный пароль", () => {
    expect(classifyAdError("80090308: LdapErr: DSID-0C0903A9, data 52e, v1db1")).toBe("invalid_credentials");
    expect(classifyAdError("data 525")).toBe("invalid_credentials");
    expect(classifyAdError("Invalid Credentials (49)")).toBe("invalid_credentials");
  });

  test("истёк срок пароля", () => {
    expect(classifyAdError("data 532")).toBe("password_expired");
    expect(classifyAdError("data 773")).toBe("password_expired");
  });

  test("учётка отключена, заблокирована или просрочена", () => {
    expect(classifyAdError("data 533")).toBe("account_disabled");
    expect(classifyAdError("data 775")).toBe("account_locked");
    expect(classifyAdError("data 701")).toBe("account_expired");
  });

  test("сетевые сбои узнаются отдельно", () => {
    expect(classifyAdError("connect ECONNREFUSED 10.0.0.1:636")).toBe("network");
    expect(classifyAdError("ETIMEDOUT")).toBe("network");
    expect(classifyAdError("getaddrinfo ENOTFOUND dc.test")).toBe("network");
  });

  test("неизвестный текст считается неверными данными", () => {
    // Пользователю безопаснее увидеть «проверьте логин/пароль», чем код LDAP.
    expect(classifyAdError("что-то непонятное")).toBe("invalid_credentials");
  });

  test("у каждой причины есть понятный текст без сырых кодов", () => {
    const kinds = ["invalid_credentials", "password_expired", "account_disabled", "account_locked",
      "account_expired", "config", "not_found", "network"] as const;
    for (const k of kinds) {
      expect(ldapFailureMessage(k)).toBeTruthy();
      expect(ldapFailureMessage(k)).not.toContain("data ");
    }
  });
});

describe("сборка логина для bind", () => {
  test("UPN: суффикс дописывается, с @ и без @", () => {
    expect(buildBindIdentifier("test", { loginFormat: "upn", upnSuffix: "@asup.local" } as LdapSettings)).toBe("test@asup.local");
    expect(buildBindIdentifier("test", { loginFormat: "upn", upnSuffix: "asup.local" } as LdapSettings)).toBe("test@asup.local");
  });

  test("готовый @ не дублируется", () => {
    expect(buildBindIdentifier("test@asup.local", { loginFormat: "upn", upnSuffix: "@asup.local" } as LdapSettings)).toBe("test@asup.local");
    expect(buildBindIdentifier("ivanov@other.local", settings())).toBe("ivanov@other.local");
  });

  test("по умолчанию формат UPN", () => {
    expect(buildBindIdentifier("user", { upnSuffix: "@stand.test" } as LdapSettings)).toBe("user@stand.test");
  });

  test("пустой суффикс оставляет логин как есть", () => {
    expect(buildBindIdentifier("ivanov", settings({ upnSuffix: "" }))).toBe("ivanov");
  });

  test("формат domain добавляет NetBIOS-домен", () => {
    expect(buildBindIdentifier("ivanov", { loginFormat: "domain", netbiosDomain: "ASUP" } as LdapSettings)).toBe("ASUP\\ivanov");
  });

  test("формат domain без домена не рисует обратный слэш", () => {
    expect(buildBindIdentifier("ivanov", settings({ loginFormat: "domain", netbiosDomain: "" }))).toBe("ivanov");
  });

  test("форматы sam и dn отдают логин без изменений", () => {
    expect(buildBindIdentifier("ivanov", settings({ loginFormat: "sam" }))).toBe("ivanov");
    expect(buildBindIdentifier("CN=A,DC=x", { loginFormat: "dn" } as LdapSettings)).toBe("CN=A,DC=x");
  });

  test("пустой логин остаётся пустым", () => {
    expect(buildBindIdentifier("   ", settings())).toBe("");
  });
});

describe("приведение логина к sAMAccountName", () => {
  test("домен\логин и логин@домен", () => {
    expect(loginToSam("TEST\\ivanov", settings())).toBe("ivanov");
    expect(loginToSam("ivanov@test.local", settings())).toBe("ivanov");
  });

  test("DN распознаётся и не режется", () => {
    expect(loginToSam("CN=Иванов,OU=K,DC=test", settings())).toBe("CN=Иванов,OU=K,DC=test");
    expect(loginToSam("OU=K,DC=test", settings({ loginFormat: "dn" }))).toBe("OU=K,DC=test");
  });

  test("обычный логин не меняется", () => {
    expect(loginToSam("ivanov", settings())).toBe("ivanov");
  });

  test("пустой логин остаётся пустым", () => {
    expect(loginToSam("", settings())).toBe("");
  });
});

describe("проверка учётных данных", () => {
  test("bind уходит с собранным логином, соединение закрывается", async () => {
    await verifyLdapCredentials(settings(), "ivanov", "пароль");
    expect(mockBind).toHaveBeenCalledWith("ivanov@test.local", "пароль");
    expect(mockUnbind).toHaveBeenCalled();
  });

  test("пустой URL заменяется локальным — иначе ldapts падает", async () => {
    await verifyLdapCredentials(settings({ url: "  " }), "ivanov", "п");
    expect(mockClientCtor).toHaveBeenCalledWith(expect.objectContaining({ url: "ldap://127.0.0.1:389" }));
  });

  test("строгая проверка сертификата включается настройкой", async () => {
    await verifyLdapCredentials(settings({ rejectUnauthorized: true }), "ivanov", "п");
    expect(mockClientCtor).toHaveBeenCalledWith(expect.objectContaining({ tlsOptions: { rejectUnauthorized: true } }));
  });

  test("ошибка bind пробрасывается, соединение всё равно закрывается", async () => {
    mockBind.mockRejectedValue(new Error("data 52e"));
    await expect(verifyLdapCredentials(settings(), "ivanov", "плохой")).rejects.toThrow();
    expect(mockUnbind).toHaveBeenCalled();
  });

  test("ошибка закрытия не перекрывает результат", async () => {
    mockUnbind.mockRejectedValue(new Error("уже закрыто"));
    await expect(verifyLdapCredentials(settings(), "ivanov", "п")).resolves.toBeUndefined();
  });
});

describe("поиск контактов", () => {
  function entry(over: Record<string, unknown> = {}) {
    return {
      dn: "CN=Иванов,OU=K,DC=test",
      sAMAccountName: "ivanov",
      displayName: "Иванов Иван",
      mail: "ivanov@test.local",
      title: "Инженер",
      department: "ИТ",
      telephoneNumber: "123",
      ...over
    };
  }

  test("без поисковой строки используется общий фильтр", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry()] });
    const res = await ldapSearchContacts(settings(), "svc", "п", "");

    const opts = mockSearch.mock.calls[0][1];
    expect(opts.filter).toContain("objectCategory=person");
    // Отключённые учётки не предлагаем в адресной книге.
    expect(opts.filter).toContain("userAccountControl:1.2.840.113556.1.4.803:=2");
    expect(res[0]).toMatchObject({ login: "ivanov", mail: "ivanov@test.local" });
  });

  test("поисковая строка добавляется по четырём атрибутам", async () => {
    await ldapSearchContacts(settings(), "svc", "п", "иван");
    const filter = mockSearch.mock.calls[0][1].filter as string;
    expect(filter).toContain("displayName=*иван*");
    expect(filter).toContain("mail=*иван*");
    expect(filter).toContain("sAMAccountName=*иван*");
    expect(filter).toContain("cn=*иван*");
  });

  test("спецсимволы в запросе экранируются", async () => {
    await ldapSearchContacts(settings(), "svc", "п", "a*(b)\\c");
    const filter = mockSearch.mock.calls[0][1].filter as string;
    // Незакрытая скобка в фильтре — синтаксическая ошибка всего запроса.
    expect(filter).toContain("\\2a");
    expect(filter).toContain("\\28");
    expect(filter).toContain("\\29");
    expect(filter).toContain("\\5c");
  });

  test("свой фильтр пользователей перекрывает стандартный", async () => {
    await ldapSearchContacts(settings({ userFilter: "(&(objectClass=user)(department=ИТ))" }), "svc", "п", "");
    expect(mockSearch.mock.calls[0][1].filter).toContain("department=ИТ");
  });

  test("лимит и атрибуты передаются в запрос", async () => {
    await ldapSearchContacts(settings({ attributes: ["mail", "cn"] }), "svc", "п", "", 50);
    const opts = mockSearch.mock.calls[0][1];
    expect(opts.sizeLimit).toBe(50);
    expect(opts.attributes).toEqual(["mail", "cn"]);
  });

  test("без своих атрибутов берётся стандартный набор", async () => {
    await ldapSearchContacts(settings(), "svc", "п", "");
    expect(mockSearch.mock.calls[0][1].attributes).toContain("displayName");
  });

  test("записи без почты и имени отбрасываются", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [entry(), entry({ mail: "", displayName: "", cn: "" })]
    });
    // Пустые строки в автодополнении бесполезны.
    expect(await ldapSearchContacts(settings(), "svc", "п", "")).toHaveLength(1);
  });

  test("значения-массивы и буферы читаются", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [entry({ displayName: ["Первый", "Второй"], mail: Buffer.from("buf@test.local") })]
    });
    const res = await ldapSearchContacts(settings(), "svc", "п", "");
    expect(res[0].displayName).toBe("Первый");
    expect(res[0].mail).toBe("buf@test.local");
  });

  test("при отсутствии displayName берётся cn", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry({ displayName: "", cn: "Иванов И.И." })] });
    expect((await ldapSearchContacts(settings(), "svc", "п", ""))[0].displayName).toBe("Иванов И.И.");
  });

  test("соединение закрывается и при ошибке поиска", async () => {
    mockSearch.mockRejectedValue(new Error("referral"));
    await expect(ldapSearchContacts(settings(), "svc", "п", "")).rejects.toThrow();
    expect(mockUnbind).toHaveBeenCalled();
  });
});

describe("выгрузка профилей сотрудников", () => {
  function profile(over: Record<string, unknown> = {}) {
    return {
      dn: "CN=Иванов,OU=K,DC=test",
      sAMAccountName: "ivanov",
      mail: "ivanov@test.local",
      displayName: "Иванов Иван",
      title: "Инженер",
      department: "ИТ",
      telephoneNumber: "123",
      userAccountControl: "512",
      ...over
    };
  }

  test("без Base DN выгрузка невозможна", async () => {
    await expect(ldapListProfiles(settings({ baseDn: "" }), "svc", "п")).rejects.toThrow(/Base DN/);
  });

  test("в фильтр добавляется требование почты", async () => {
    await ldapListProfiles(settings(), "svc", "п");
    expect(mockSearch.mock.calls[0][1].filter).toContain("(mail=*)");
  });

  test("признак отключённой учётки читается из userAccountControl", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ userAccountControl: "546" })] });
    // Бит 0x2 = ACCOUNTDISABLE.
    expect((await ldapListProfiles(settings(), "svc", "п"))[0].disabled).toBe(true);
  });

  test("активная учётка не помечается отключённой", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ userAccountControl: "512" })] });
    expect((await ldapListProfiles(settings(), "svc", "п"))[0].disabled).toBe(false);
  });

  test("без userAccountControl учётка считается активной", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ userAccountControl: undefined })] });
    expect((await ldapListProfiles(settings(), "svc", "п"))[0].disabled).toBe(false);
  });

  test("руководитель переносится, пустые поля не дают «undefined»", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [profile({ manager: "CN=Петров,OU=K,DC=test", title: undefined })]
    });
    const p = (await ldapListProfiles(settings(), "svc", "п"))[0];
    expect(p.managerDn).toBe("CN=Петров,OU=K,DC=test");
    expect(p.position).toBe("");
  });

  test("без руководителя поле пустое", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile()] });
    expect((await ldapListProfiles(settings(), "svc", "п"))[0].managerDn).toBeNull();
  });

  test("записи без логина или почты отбрасываются", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [profile(), profile({ sAMAccountName: "" }), profile({ mail: "" })]
    });
    // Такие учётные записи бесполезны для входа и уведомлений.
    expect(await ldapListProfiles(settings(), "svc", "п")).toHaveLength(1);
  });

  test("полное имя подставляется из cn, если нет displayName", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ displayName: "", cn: "Иванов И.И." })] });
    expect((await ldapListProfiles(settings(), "svc", "п"))[0].fullName).toBe("Иванов И.И.");
  });
});

describe("аутентификация", () => {
  function entry(over: Record<string, unknown> = {}) {
    return {
      dn: "CN=Иванов,OU=K,DC=test",
      sAMAccountName: "ivanov",
      mail: "ivanov@test.local",
      displayName: "Иванов Иван",
      title: "Инженер",
      department: "ИТ",
      userAccountControl: "512",
      ...over
    };
  }

  test("пустой логин и пароль отклоняются до обращения к каталогу", async () => {
    await expect(ldapAuthenticate(settings(), "", "п")).rejects.toThrow(/логин/i);
    await expect(ldapAuthenticate(settings(), "ivanov", "")).rejects.toThrow(/пароль/i);
    expect(mockBind).not.toHaveBeenCalled();
  });

  test("успешный вход возвращает профиль", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry()] });
    const p = await ldapAuthenticate(settings(), "ivanov", "пароль");

    expect(mockBind).toHaveBeenCalledWith("ivanov@test.local", "пароль");
    expect(p).toMatchObject({ ldapUid: "ivanov", email: "ivanov@test.local", fullName: "Иванов Иван" });
    expect(p.disabled).toBe(false);
  });

  test("отказ bind превращается в понятную причину", async () => {
    mockBind.mockRejectedValue(new Error("80090308: data 52e"));
    const err = await ldapAuthenticate(settings(), "ivanov", "плохой").catch((e) => e as LdapError);
    expect(err).toBeInstanceOf(LdapError);
    expect(err.kind).toBe("invalid_credentials");
  });

  test("отключённая учётка распознаётся", async () => {
    mockBind.mockRejectedValue(new Error("data 533"));
    const err = await ldapAuthenticate(settings(), "ivanov", "п").catch((e) => e as LdapError);
    expect(err.kind).toBe("account_disabled");
  });

  test("без Base DN — ошибка настройки, соединение закрывается", async () => {
    const err = await ldapAuthenticate(settings({ baseDn: "" }), "ivanov", "п").catch((e) => e as LdapError);
    expect(err).toBeInstanceOf(LdapError);
    expect(err.kind).toBe("config");
    expect(mockUnbind).toHaveBeenCalled();
  });

  test("referral от корня домена объясняется понятным текстом", async () => {
    mockSearch.mockRejectedValue(new Error("Referral received (operations error)"));
    const err = await ldapAuthenticate(settings(), "ivanov", "п").catch((e) => e as LdapError);
    // AD отвечает ссылкой, если искать от корня домена — подсказываем про OU.
    expect(err.kind).toBe("config");
    expect(err.message).toContain("OU=");
  });

  test("учётка не найдена в каталоге", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [] });
    const err = await ldapAuthenticate(settings(), "ivanov", "п").catch((e) => e as LdapError);
    expect(err.kind).toBe("not_found");
  });

  test("поиск идёт по DN, если введён DN", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry()] });
    await ldapAuthenticate(settings({ loginFormat: "dn" }), "CN=Иванов,OU=K,DC=test", "п");
    expect(mockSearch.mock.calls[0][1].filter).toContain("distinguishedName=");
  });

  test("логин со спецсимволами экранируется в фильтре", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry()] });
    await ldapAuthenticate(settings(), "iva*nov", "п");
    expect(mockSearch.mock.calls[0][1].filter).toContain("\\2a");
  });

  test("отключённая учётка в каталоге помечается", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry({ userAccountControl: "514" })] });
    expect((await ldapAuthenticate(settings(), "ivanov", "п")).disabled).toBe(true);
  });

  test("профиль опознаётся по логину, если каталог не отдал sAMAccountName", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [entry({ sAMAccountName: "" })] });
    expect((await ldapAuthenticate(settings(), "ivanov", "п")).ldapUid).toBe("ivanov");
  });

  test("соединение закрывается даже при отказе bind", async () => {
    mockBind.mockRejectedValue(new Error("data 52e"));
    await ldapAuthenticate(settings(), "ivanov", "п").catch(() => undefined);
    expect(mockUnbind).toHaveBeenCalled();
  });
});
