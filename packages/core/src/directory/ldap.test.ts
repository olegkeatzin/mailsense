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
import { logger } from "../logger.js";
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

/** Сколько записей AD отдаёт на один непостраничный поиск (MaxPageSize). */
const AD_MAX_PAGE_SIZE = 1000;
/** Размер страницы, который обязан запросить клиент. */
const EXPECTED_PAGE_SIZE = 1000;

function person(i: number) {
  return {
    dn: "CN=User" + i + ",OU=K,DC=test",
    sAMAccountName: "user" + i,
    mail: "user" + i + "@test.local",
    displayName: "Сотрудник " + i,
    userAccountControl: "512"
  };
}

/**
 * Поддельный AD. Непостраничный поиск отдаёт только первую страницу (как
 * настоящий: остальное он прячет за cookie). Постраничный — обходит все
 * страницы, каждая следующая доступна только по cookie от предыдущей.
 * Поэтому если из ldapListProfiles убрать paged, тест немедленно краснеет:
 * вернётся ровно страница, а не весь каталог.
 */
function fakeAd(total: number) {
  const pagesServed: number[] = [];
  mockSearch.mockImplementation(async (_base: string, options: Record<string, unknown>) => {
    const paged = options.paged as { pageSize?: number } | undefined;

    if (!paged) {
      // Настоящий AD отдаёт минимум из своего MaxPageSize и запрошенного sizeLimit.
      const asked =
        typeof options.sizeLimit === "number" && options.sizeLimit > 0
          ? options.sizeLimit
          : AD_MAX_PAGE_SIZE;
      const size = Math.min(total, AD_MAX_PAGE_SIZE, asked);
      pagesServed.push(size);
      return { searchEntries: Array.from({ length: size }, (_, i) => person(i)) };
    }

    const pageSize = paged.pageSize ?? 100;
    const entries: unknown[] = [];
    let cookie = "начальная-страница";
    let page = 0;
    // Пока сервер отдаёт cookie — есть что продолжать.
    while (cookie) {
      const from = page * pageSize;
      const chunk = Array.from(
        { length: Math.max(0, Math.min(pageSize, total - from)) },
        (_, k) => person(from + k)
      );
      entries.push(...chunk);
      pagesServed.push(chunk.length);
      page++;
      cookie = page * pageSize < total ? "cookie-" + page : "";
    }
    return { searchEntries: entries };
  });
  return { pagesServed };
}

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

  test("неизвестная ошибка не выдаётся за неверный пароль", () => {
    // Раньше здесь возвращалось invalid_credentials. На приёмке это стоило времени: при заведомо
    // верном пароле администратор видел «Неверный логин или пароль», хотя контроллер отвечал кодом,
    // которого классификатор не знал. Честнее сказать «причина в журнале сервера», а код записать в лог.
    expect(classifyAdError("что-то непонятное")).toBe("unknown");
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

/**
 * ldapts 9.x включает TLS при ЛЮБОМ определённом `tlsOptions`, даже если схема `ldap://`
 * (`secure = isSecureProtocol || hasTlsOptions`). На боевом контуре это выглядело так:
 * `ldapsearch -H ldap://192.168.1.40:389` с той же учёткой работает, а вход в приложение
 * падает с `read ECONNRESET` — клиент слал TLS ClientHello на открытый порт 389,
 * и контроллер рвал соединение. Три коммита с повторами при обрыве лечили симптом.
 */
describe("TLS только для ldaps://", () => {
  test("на ldap:// tlsOptions не передаётся — иначе TLS уходит на открытый порт", async () => {
    await verifyLdapCredentials(settings({ url: "ldap://192.168.1.40:389" }), "ivanov", "п");
    const opts = mockClientCtor.mock.calls[0][0];
    expect(opts.url).toBe("ldap://192.168.1.40:389");
    expect(opts.tlsOptions).toBeUndefined();
  });

  test("на ldaps:// tlsOptions передаётся вместе с настройкой проверки сертификата", async () => {
    await verifyLdapCredentials(settings({ url: "ldaps://192.168.1.40:636" }), "ivanov", "п");
    expect(mockClientCtor.mock.calls[0][0].tlsOptions).toEqual({ rejectUnauthorized: false });

    await verifyLdapCredentials(
      settings({ url: "ldaps://192.168.1.40:636", rejectUnauthorized: true }),
      "ivanov",
      "п"
    );
    expect(mockClientCtor.mock.calls[1][0].tlsOptions).toEqual({ rejectUnauthorized: true });
  });

  test("решение о TLS не зависит от регистра схемы", async () => {
    await verifyLdapCredentials(settings({ url: "LDAPS://192.168.1.40:636" }), "ivanov", "п");
    expect(mockClientCtor.mock.calls[0][0].tlsOptions).toEqual({ rejectUnauthorized: false });
  });

  test("все обращения к каталогу идут через одно правило", async () => {
    const plain = settings({ url: "ldap://192.168.1.40:389" });
    // Вход (bind), поиск контактов и полная выгрузка профилей — один и тот же clientOf().
    await verifyLdapCredentials(plain, "ivanov", "п");
    await ldapSearchContacts(plain, "ivanov", "п", "иван");
    await ldapListProfiles(plain, "ivanov", "п");
    expect(mockClientCtor).toHaveBeenCalledTimes(3);
    for (const call of mockClientCtor.mock.calls) expect(call[0].tlsOptions).toBeUndefined();
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

describe("полная выгрузка контактов в кэш", () => {
  test("выгрузка больше страницы идёт постранично, а не отдаёт 1000", async () => {
    // refreshDirectory() в directoryService тянет каталог в кэш именно так:
    // ldapSearchContacts(..., "", 2000). Без страниц AD отдавал 1000 записей,
    // и кэш адресной книги молча оставался неполным.
    const { pagesServed } = fakeAd(2500);
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const list = await ldapSearchContacts(settings(), "svc", "п", "", 2000);
      expect(list).toHaveLength(2000);
      expect(pagesServed).toEqual([1000, 1000, 500]);
      // Обрезали по пределу выгрузки — это видно в логе.
      expect(JSON.stringify(warnSpy.mock.calls)).toContain("2000");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("автодополнение остаётся точечным запросом без страниц", async () => {
    // Для 25 подсказок страницы не нужны: они тянут весь набор совпадений.
    fakeAd(2500);
    const list = await ldapSearchContacts(settings(), "svc", "п", "иван", 25);
    const opts = mockSearch.mock.calls[0][1];
    expect(opts.paged).toBeUndefined();
    expect(opts.sizeLimit).toBe(25);
    expect(list.length).toBeLessThanOrEqual(25);
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
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles[0].disabled).toBe(true);
  });

  test("активная учётка не помечается отключённой", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ userAccountControl: "512" })] });
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles[0].disabled).toBe(false);
  });

  test("без userAccountControl учётка считается активной", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ userAccountControl: undefined })] });
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles[0].disabled).toBe(false);
  });

  test("руководитель переносится, пустые поля не дают «undefined»", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [profile({ manager: "CN=Петров,OU=K,DC=test", title: undefined })]
    });
    const p = (await ldapListProfiles(settings(), "svc", "п")).profiles[0];
    expect(p.managerDn).toBe("CN=Петров,OU=K,DC=test");
    expect(p.position).toBe("");
  });

  test("без руководителя поле пустое", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile()] });
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles[0].managerDn).toBeNull();
  });

  test("записи без логина или почты отбрасываются", async () => {
    mockSearch.mockResolvedValue({
      searchEntries: [profile(), profile({ sAMAccountName: "" }), profile({ mail: "" })]
    });
    // Такие учётные записи бесполезны для входа и уведомлений.
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles).toHaveLength(1);
  });

  test("полное имя подставляется из cn, если нет displayName", async () => {
    mockSearch.mockResolvedValue({ searchEntries: [profile({ displayName: "", cn: "Иванов И.И." })] });
    expect((await ldapListProfiles(settings(), "svc", "п")).profiles[0].fullName).toBe("Иванов И.И.");
  });
});

/**
 * Постраничный обход каталога. Найденный дефект: один search без paged results —
 * AD отдаёт не больше MaxPageSize (по умолчанию 1000) и на этом останавливается.
 * docflow считает полученный список ПОЛНЫМ каталогом и деактивирует всех, кого
 * в нём не оказалось: люди за первой страницей выключались каждую синхронизацию.
 */
describe("постраничная выгрузка каталога", () => {
  test("каталог больше страницы: обход доходит до конца, а не отдаёт первую страницу", async () => {
    const { pagesServed } = fakeAd(2500);

    const { profiles } = await ldapListProfiles(settings(), "svc", "п");

    // Все 2500, а не 1000: хвост каталога больше не теряется.
    expect(profiles).toHaveLength(2500);
    expect(profiles[profiles.length - 1].ldapUid).toBe("user2499");
    expect(profiles.some((p) => p.ldapUid === "user1500")).toBe(true);
    // Прочитано три страницы: 1000 + 1000 + 500.
    expect(pagesServed).toEqual([1000, 1000, 500]);
  });

  test("запрошена именно постраничная выдача с разумным размером страницы", async () => {
    fakeAd(10);

    await ldapListProfiles(settings(), "svc", "п");

    // Без paged AD снова вернёт только первую страницу — это и был дефект.
    const opts = mockSearch.mock.calls[0][1];
    expect(opts.paged).toEqual({ pageSize: EXPECTED_PAGE_SIZE });
    // Предел на весь поиск серверу не отдаём: вместе с постраничной выдачей он
    // режет результат по всему каталогу и возвращает sizeLimitExceeded с частью
    // записей — синхронизация снова посчитала бы список полным.
    expect(opts.sizeLimit).toBe(0);
  });

  test("каталог ровно в одну страницу не ломается", async () => {
    fakeAd(1000);

    const page = await ldapListProfiles(settings(), "svc", "п");
    expect(page.profiles).toHaveLength(1000);
    expect(page.truncated).toBe(false);
  });

  test("каталог больше предела: выставлен признак неполноты", async () => {
    fakeAd(2500);
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const res = await ldapListProfiles(settings(), "svc", "п", 1000);

      // По этому признаку вызывающий обязан отказаться от деактивации:
      // иначе он выключит всех, кого не увидел в обрезанном списке.
      expect(res.truncated).toBe(true);
      expect(res.total).toBe(2500);
      expect(res.profiles).toHaveLength(1000);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("в пределах предела признак неполноты не выставлен", async () => {
    fakeAd(300);

    const res = await ldapListProfiles(settings(), "svc", "п", 1000);

    expect(res.truncated).toBe(false);
    expect(res.total).toBe(300);
    expect(res.profiles).toHaveLength(300);
  });

  test("возвращается объект с признаком, а не голый массив", async () => {
    // Осознанный разрыв контракта: старый код (list.map / list.length) обязан
    // упасть на сборке типов, а не молча счесть обрезанный список полным каталогом.
    fakeAd(5);

    const res = await ldapListProfiles(settings(), "svc", "п");

    expect(Array.isArray(res)).toBe(false);
    expect(Object.keys(res).sort()).toEqual(["profiles", "total", "truncated"]);
  });

  test("пустой каталог — полный список из нуля записей", async () => {
    fakeAd(0);
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const res = await ldapListProfiles(settings(), "svc", "п");
      expect(res).toEqual({ profiles: [], total: 0, truncated: false });
      // Ноль сотрудников — почти всегда неверный Base DN: предупреждаем.
      expect(JSON.stringify(warnSpy.mock.calls)).toContain("Base DN");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("предел выгрузки всё ещё защищает от лавины, но виден в логе", async () => {
    fakeAd(2500);
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      const { profiles, total, truncated } = await ldapListProfiles(settings(), "svc", "п", 1200);
      expect(profiles).toHaveLength(1200);
      expect(total).toBe(2500);
      expect(truncated).toBe(true);
      // Молча обрезать нельзя: иначе снова тихо выключенные люди.
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain("1200");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("в пределах лимита предупреждения нет", async () => {
    fakeAd(1500);
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    try {
      expect((await ldapListProfiles(settings(), "svc", "п", 2000)).profiles).toHaveLength(1500);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("страницы не отменяют отбрасывание записей без логина и почты", async () => {
    // Усечённые записи приходят с любой страницы — фильтр должен работать после обхода.
    mockSearch.mockResolvedValue({
      searchEntries: [person(1), { ...person(2), mail: "" }, { ...person(3), sAMAccountName: "" }]
    });
    const { profiles } = await ldapListProfiles(settings(), "svc", "п");
    expect(profiles.map((p) => p.ldapUid)).toEqual(["user1"]);
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
describe("служебная учётная запись каталога (прод: data 775)", () => {
  test("заблокированная учётка: по-русски и как LdapError, а не сырой текст AD", async () => {
    mockBind.mockRejectedValueOnce(
      new Error("80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 775, v1db1 Code: 0x31")
    );

    const failure = await ldapListProfiles(settings(), "ldap-bind@test", "пароль").catch((e) => e);

    expect(failure).toBeInstanceOf(LdapError);
    expect(failure.kind).toBe("account_locked");
    expect(failure.message).toContain("заблокирована");
    expect(failure.message).toContain("Каталог (LDAP)");
  });

  test("неверный пароль служебной учётки — тоже LdapError с причиной", async () => {
    mockBind.mockRejectedValueOnce(new Error("80090308: LdapErr: DSID-0C0903A9, data 52e, v1db1 Code: 0x31"));

    const failure = await ldapListProfiles(settings(), "ldap-bind@test", "пароль").catch((e) => e);

    expect(failure).toBeInstanceOf(LdapError);
    expect(failure.kind).toBe("invalid_credentials");
    expect(failure.message).toContain("Неверный логин или пароль");
  });
});
