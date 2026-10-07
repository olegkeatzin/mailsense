import {
  normalizeServerAddress,
  parseServerAddress,
  parseServerConfig,
  resolveServerAddress,
  serverAddressFromEnv
} from "./clientConfig.js";

/**
 * Откуда клиент берёт адрес сервера СЭД (решение Р21, пункт Т6 плана).
 *
 * Порядок источников задан постановкой: явный аргумент --server=… → server.json РЯДОМ
 * с исполняемым файлом (конфиг предприятия, его кладёт администратор) → server.json
 * в каталоге пользователя (личная настройка) → переменная окружения MAILSENSE_SERVER_URL.
 *
 * ⚠️ Правило «присутствие важнее содержимого»: если файл ЕСТЬ, но испорчен — это честная
 * ошибка, а не повод молча пойти искать адрес в следующем источнике (иначе пользователь
 * подключился бы не к тому серверу, который ему выдали).
 */
describe("разбор значения адреса", () => {
  test("нормальный адрес нормализуется (хвостовые слэши убираются)", () => {
    expect(normalizeServerAddress("  https://doc.company.local///  ")).toBe("https://doc.company.local");
    expect(normalizeServerAddress("http://192.168.1.10:8123")).toBe("http://192.168.1.10:8123");
  });

  test("только http и https", () => {
    expect(normalizeServerAddress("ftp://doc.company.local")).toBeNull();
    expect(normalizeServerAddress("doc.company.local")).toBeNull();
    expect(normalizeServerAddress("javascript:alert(1)")).toBeNull();
  });

  test("пустой хост — не адрес", () => {
    expect(normalizeServerAddress("https://")).toBeNull();
    expect(normalizeServerAddress("http:///path")).toBeNull();
  });

  test("пустое значение — «не задано», а не ошибка", () => {
    const r = parseServerAddress("   ");
    expect(r).toEqual({ url: null, error: null });
  });

  test("мусор в значении аргумента даёт причину", () => {
    const r = parseServerAddress("ftp://doc.company.local");
    expect(r.url).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

describe("разбор server.json", () => {
  test("нормальный файл", () => {
    expect(parseServerConfig('{"serverUrl": "https://doc.company.local/"}')).toEqual({
      present: true,
      url: "https://doc.company.local",
      error: null
    });
  });

  test("явный null или пустая строка — «локальный режим», а не ошибка", () => {
    expect(parseServerConfig('{"serverUrl": null}')).toEqual({ present: true, url: null, error: null });
    expect(parseServerConfig('{"serverUrl": ""}')).toEqual({ present: true, url: null, error: null });
  });

  test("отсутствие файла — источника нет", () => {
    expect(parseServerConfig(undefined)).toEqual({ present: false, url: null, error: null });
  });

  test("испорченный JSON — честная ошибка, а не null молча", () => {
    const r = parseServerConfig("{это не json");
    expect(r.present).toBe(true);
    expect(r.url).toBeNull();
    expect(r.error).toContain("JSON");
  });

  test("пустой файл — ошибка: администратор положил файл, значит он что-то имел в виду", () => {
    expect(parseServerConfig("   ").error).toBeTruthy();
  });

  test("JSON без serverUrl и неверный тип — ошибка", () => {
    expect(parseServerConfig("{}").error).toBeTruthy();
    expect(parseServerConfig('{"serverUrl": 42}').error).toBeTruthy();
    expect(parseServerConfig('"https://doc.company.local"').error).toBeTruthy();
  });

  test("адрес не http/https или с пустым хостом — ошибка с причиной", () => {
    expect(parseServerConfig('{"serverUrl": "ftp://x"}').error).toBeTruthy();
    expect(parseServerConfig('{"serverUrl": "https://"}').error).toBeTruthy();
  });
});

describe("имя переменной окружения", () => {
  test("каноническое имя MAILSENSE_SERVER_URL", () => {
    expect(serverAddressFromEnv({ MAILSENSE_SERVER_URL: "https://doc.company.local" })).toBe(
      "https://doc.company.local"
    );
  });

  test("прежнее имя MAILSENSE_DOCFLOW_URL принимается — стенды не ломаются", () => {
    expect(serverAddressFromEnv({ MAILSENSE_DOCFLOW_URL: "https://legacy.company.local" })).toBe(
      "https://legacy.company.local"
    );
  });

  test("каноническое имя важнее прежнего", () => {
    expect(
      serverAddressFromEnv({
        MAILSENSE_SERVER_URL: "https://new.company.local",
        MAILSENSE_DOCFLOW_URL: "https://legacy.company.local"
      })
    ).toBe("https://new.company.local");
  });

  test("пустое каноническое значение не мешает прежнему имени", () => {
    expect(serverAddressFromEnv({ MAILSENSE_SERVER_URL: "   ", MAILSENSE_DOCFLOW_URL: "https://legacy.local" })).toBe(
      "https://legacy.local"
    );
  });

  test("обе переменные пусты — источника нет", () => {
    expect(serverAddressFromEnv({})).toBeNull();
    expect(serverAddressFromEnv({ MAILSENSE_SERVER_URL: "", MAILSENSE_DOCFLOW_URL: "" })).toBeNull();
  });

  test("через resolveServerAddress: прежнее имя тоже даёт адрес", () => {
    const r = resolveServerAddress({ env: serverAddressFromEnv({ MAILSENSE_DOCFLOW_URL: "https://legacy.local" }) });
    expect(r).toMatchObject({ url: "https://legacy.local", source: "env" });
  });
});

describe("порядок источников", () => {
  const install = '{"serverUrl": "https://install.company.local"}';
  const user = '{"serverUrl": "https://user.company.local"}';

  test("аргумент важнее всех", () => {
    const r = resolveServerAddress({ arg: "https://from-arg.local", installFile: install, userFile: user, env: "https://env.local" });
    expect(r).toMatchObject({ url: "https://from-arg.local", source: "arg", managedByAdmin: false, error: null });
  });

  test("файл установки важнее личного файла и переменной, и помечается как админский", () => {
    const r = resolveServerAddress({ installFile: install, userFile: user, env: "https://env.local" });
    expect(r).toMatchObject({ url: "https://install.company.local", source: "install", managedByAdmin: true, error: null });
  });

  test("личный файл важнее переменной окружения", () => {
    const r = resolveServerAddress({ userFile: user, env: "https://env.local" });
    expect(r).toMatchObject({ url: "https://user.company.local", source: "user", managedByAdmin: false });
  });

  test("переменная окружения — последний источник", () => {
    const r = resolveServerAddress({ env: "https://env.local" });
    expect(r).toMatchObject({ url: "https://env.local", source: "env", managedByAdmin: false });
  });

  test("ничего не задано — локальный режим, это не ошибка", () => {
    expect(resolveServerAddress({})).toEqual({ url: null, source: null, managedByAdmin: false, error: null });
  });

  test("испорченный файл установки: ошибка и НЕ идём искать дальше", () => {
    const r = resolveServerAddress({ installFile: "{мусор", userFile: user, env: "https://env.local" });
    expect(r.url).toBeNull();
    expect(r.source).toBe("install");
    expect(r.managedByAdmin).toBe(true);
    expect(r.error).toBeTruthy();
  });

  test("испорченный личный файл: ошибка и НЕ падаем на переменную", () => {
    const r = resolveServerAddress({ userFile: '{"serverUrl": "ftp://x"}', env: "https://env.local" });
    expect(r.url).toBeNull();
    expect(r.source).toBe("user");
    expect(r.error).toBeTruthy();
  });

  test("мусор в аргументе — ошибка, а не тихий переход к файлу", () => {
    const r = resolveServerAddress({ arg: "не адрес", installFile: install });
    expect(r).toMatchObject({ url: null, source: "arg", managedByAdmin: false });
    expect(r.error).toBeTruthy();
  });

  test("админский файл с явным null — это выбор «локально», его не перебивает личный файл", () => {
    const r = resolveServerAddress({ installFile: '{"serverUrl": null}', userFile: user });
    expect(r).toMatchObject({ url: null, source: "install", managedByAdmin: true, error: null });
  });

  test("пустой аргумент --server= не считается заданным", () => {
    const r = resolveServerAddress({ arg: "   ", userFile: user });
    expect(r).toMatchObject({ url: "https://user.company.local", source: "user" });
  });
});
