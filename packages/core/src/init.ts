import { loadConfig, type Config } from "./config.js";
import { initDb } from "./db/index.js";
import { NodeSecretStore, type SecretStore } from "./secrets.js";
import { initContext } from "./context.js";
import { countAccounts, insertAccount } from "./repos.js";
import { logger, setupFileLogging, setupErrorHandlers } from "./logger.js";
import { runStartupMaintenance } from "./services/maintenance.js";
import { seedMailboxes, type MailboxSeedReport } from "./services/mailboxSeed.js";

export interface InitResult {
  config: Config;
  secrets: SecretStore;
  /** Итог засева ящиков из окружения: сервер его логирует. */
  mailboxSeed: MailboxSeedReport;
}

export function initApp(overrides?: Partial<Config>, secretStore?: SecretStore): InitResult {
  const config: Config = { ...loadConfig(), ...overrides };
  initDb(config.dataDir);
  setupFileLogging(config.dataDir);
  setupErrorHandlers();
  const secrets = secretStore ?? new NodeSecretStore(config.dataDir);
  initContext({ config, secrets });

  // Обратная совместимость: одиночный засев (MAILSENSE_SEED_ACCOUNT + MAILSENSE_MAIL_*)
  // работает как раньше — только на пустой базе и до списка.
  if (config.seedAccount && config.defaultAccount && countAccounts() === 0) {
    insertAccount(config.defaultAccount, secrets.encrypt(config.defaultAccount.password));
    logger.info("Засеян тестовый аккаунт по умолчанию: " + config.defaultAccount.username);
  }

  // Список ящиков из MAILSENSE_MAILBOXES: только отсутствующие, плохой элемент не роняет остальные.
  const mailboxSeed = seedMailboxes(config, secrets);
  if (mailboxSeed.created || mailboxSeed.skipped || mailboxSeed.failed) {
    logger.info(mailboxSeed, "Засев ящиков из окружения завершён");
  }

  // Одноразовая починка данных после апгрейда (ложный статус, пересборка бесед).
  try {
    runStartupMaintenance();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Не удалось выполнить обслуживание данных");
  }

  // Серверная часть (документооборот) инициализируется отдельно — у неё своя база.
  return { config, secrets, mailboxSeed };
}
