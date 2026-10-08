import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { applyDocflowStartupPolicy, parseDocflowEnabledEnv } from "./docflowStartup.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Включение документооборота при старте (T48).
 *
 * Проверяем ровно то, из-за чего развёртывание упиралось в тупик: на свежем сервере
 * документооборот должен включиться сам, а явную настройку администратора трогать нельзя.
 */
const coreMocks = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock>;

/** Стенд политики: пишем туда же, куда писал бы сервер. */
function harness(opts: { setting?: string | null; env?: string | null; server?: boolean } = {}) {
  const writes: boolean[] = [];
  return {
    writes,
    run: () =>
      applyDocflowStartupPolicy({
        serverDatabase: opts.server !== false,
        envValue: opts.env ?? undefined,
        readSetting: async () => (opts.setting === undefined ? null : opts.setting),
        writeSetting: async (enabled: boolean) => {
          writes.push(enabled);
        }
      })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("свежее серверное развёртывание", () => {
  test("без настройки в базе документооборот включается сам", async () => {
    const h = harness({ setting: null });

    expect(await h.run()).toBe("enabled_fresh_server");
    expect(h.writes).toEqual([true]);
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("включён автоматически")
    );
  });

  test("явную настройку администратора НЕ перетираем", async () => {
    for (const setting of ["true", "false"]) {
      const h = harness({ setting });

      expect(await h.run()).toBe("explicit_setting");
      expect(h.writes).toEqual([]);
    }
  });
});

describe("переменная развёртывания MAILSENSE_DOCFLOW_ENABLED", () => {
  test("true включает документооборот", async () => {
    const h = harness({ env: "true", setting: null });

    expect(await h.run()).toBe("enabled_by_env");
    expect(h.writes).toEqual([true]);
  });

  test("false только ПОДАВЛЯЕТ автовключение и ничего не пишет", async () => {
    const h = harness({ env: "false", setting: null });

    expect(await h.run()).toBe("disabled_by_env");
    // ⚠️ Ни одной записи: перезапись чужого решения на старте недопустима.
    expect(h.writes).toEqual([]);
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      expect.stringContaining("подавлено")
    );
  });

  test("false не отменяет решение администратора: настройка true остаётся true", async () => {
    const h = harness({ env: "false", setting: "true" });

    expect(await h.run()).toBe("disabled_by_env");
    expect(h.writes).toEqual([]);
  });

  test("русские да/нет тоже понимаются", async () => {
    const yes = harness({ env: "да", setting: null });
    expect(await yes.run()).toBe("enabled_by_env");
    expect(yes.writes).toEqual([true]);

    const no = harness({ env: "нет", setting: null });
    expect(await no.run()).toBe("disabled_by_env");
    // «нет» — то же правило, что и false: только подавляем, не пишем.
    expect(no.writes).toEqual([]);
  });

  test("нераспознанное значение не ломает старт: журнал предупреждает и работает автоправило", async () => {
    const h = harness({ env: "может быть", setting: null });

    expect(await h.run()).toBe("enabled_fresh_server");
    expect(h.writes).toEqual([true]);
    expect(coreMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ value: "может быть" }),
      expect.stringContaining("не распознан")
    );
  });
});

describe("локальный режим (нет DOCFLOW_DATABASE_URL)", () => {
  test("документооборот не включаем и настройку не пишем", async () => {
    const h = harness({ server: false, setting: null });

    expect(await h.run()).toBe("not_server_mode");
    expect(h.writes).toEqual([]);
    expect(coreMocks.logger.info).not.toHaveBeenCalled();
  });

  test("заданная переменная не действует — говорим об этом в журнале", async () => {
    const h = harness({ server: false, env: "true" });

    expect(await h.run()).toBe("not_server_mode");
    expect(h.writes).toEqual([]);
    expect(coreMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ value: "true" }),
      expect.stringContaining("переменная не действует")
    );
  });
});

describe("разбор значения переменной", () => {
  test("пусто и мусор — не задано", () => {
    expect(parseDocflowEnabledEnv(undefined)).toBeUndefined();
    expect(parseDocflowEnabledEnv("")).toBeUndefined();
    expect(parseDocflowEnabledEnv("  ")).toBeUndefined();
    expect(parseDocflowEnabledEnv("ага")).toBeUndefined();
  });

  test("true/false в любом регистре, 1/0, да/нет", () => {
    for (const v of ["true", "TRUE", "True", "1", "yes", "да"]) expect(parseDocflowEnabledEnv(v)).toBe(true);
    for (const v of ["false", "FALSE", "0", "no", "нет"]) expect(parseDocflowEnabledEnv(v)).toBe(false);
  });
});
