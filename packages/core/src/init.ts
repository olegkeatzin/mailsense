import { loadConfig, type Config } from "./config.js";
import { initDb } from "./db/index.js";
import { NodeSecretStore, type SecretStore } from "./secrets.js";
import { initContext } from "./context.js";
import { countAccounts, insertAccount } from "./repos.js";
import { logger, setupFileLogging, setupErrorHandlers } from "./logger.js";
import { runStartupMaintenance } from "./services/maintenance.js";

export interface InitResult {
  config: Config;
  secrets: SecretStore;
}

export function initApp(overrides?: Partial<Config>, secretStore?: SecretStore): InitResult {
  const config: Config = { ...loadConfig(), ...overrides };
  initDb(config.dataDir);
  setupFileLogging(config.dataDir);
  setupErrorHandlers();
  const secrets = secretStore ?? new NodeSecretStore(config.dataDir);
  initContext({ config, secrets });

  if (config.seedAccount && config.defaultAccount && countAccounts() === 0) {
    insertAccount(config.defaultAccount, secrets.encrypt(config.defaultAccount.password));
    logger.info("Засеян тестовый аккаунт по умолчанию: " + config.defaultAccount.username);
  }

  // Одноразовая починка данных после апгрейда (ложный статус, пересборка бесед).
  try {
    runStartupMaintenance();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Не удалось выполнить обслуживание данных");
  }
  return { config, secrets };
}
