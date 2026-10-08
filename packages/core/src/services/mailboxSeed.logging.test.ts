/**
 * Предупреждения засева обязаны попадать В ЖУРНАЛ: опечатка в имени поля (smtpPortt)
 * иначе тихо не применилась бы, и причину искали бы в другом месте. Здесь логгер подменён —
 * проверяем именно факт записи и её текст, без базы и без файлового лога.
 */
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock("../logger.js", () => ({
  __esModule: true,
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    info: (...args: unknown[]) => mockInfo(...args),
    error: jest.fn(),
    debug: jest.fn()
  },
  setupFileLogging: jest.fn(),
  setupErrorHandlers: jest.fn()
}));

import type { Config } from "../config.js";
import type { SecretStore } from "../secrets.js";
import { seedMailboxes } from "./mailboxSeed.js";

const secrets = { encrypt: (s: string) => "enc:" + s, decrypt: (s: string) => s } as unknown as SecretStore;
const config = (over: Partial<Config> = {}): Pick<Config, "mailboxes" | "mailboxErrors" | "mailboxWarnings"> => ({
  mailboxes: [],
  mailboxErrors: [],
  mailboxWarnings: [],
  ...over
});

beforeEach(() => {
  mockWarn.mockReset();
  mockInfo.mockReset();
});

describe("журнал засева ящиков", () => {
  test("неизвестные поля пишутся предупреждением", () => {
    const report = seedMailboxes(
      config({ mailboxWarnings: ["ящик #1 (post@mail.test): неизвестные поля smtpPortt — пропущены"] }),
      secrets
    );

    expect(report).toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0][0])).toContain("неизвестные поля smtpPortt");
  });

  test("причина пропуска ящика идёт и в отказы, и в журнал", () => {
    const report = seedMailboxes(config({ mailboxErrors: ["ящик #2: неизвестный протокол — ожидается imap или pop3"] }), secrets);

    expect(report).toEqual({ created: 0, skipped: 0, failed: 1 });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0][0])).toContain("неизвестный протокол");
  });

  test("без причин и предупреждений журнал не трогаем", () => {
    expect(seedMailboxes(config(), secrets)).toEqual({ created: 0, skipped: 0, failed: 0 });
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });
});
