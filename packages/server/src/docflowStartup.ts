import { getSetting, setDocflowEnabled, SETTING_DOCFLOW_ENABLED } from "@mailsense/docflow";
import { logger } from "@mailsense/core";

/**
 * Включение документооборота при старте (T48).
 *
 * ⚠️ Почему это нужно: в контейнерном развёртывании задан DOCFLOW_DATABASE_URL, то есть
 * разворачивают именно СЭД. Но настройка `docflow.enabled` по умолчанию "false", а вход
 * администратора живёт В документообороте: на свежем сервере человек получал выключенную СЭД,
 * открытый наружу API без входа и не мог включить её, пока не войдёт. Тупик первичной настройки.
 *
 * Правило:
 *   1) MAILSENSE_DOCFLOW_ENABLED=true — включаем и пишем настройку (оператор развернул СЭД явно);
 *   2) MAILSENSE_DOCFLOW_ENABLED=false — ТОЛЬКО подавляем автовключение и НИЧЕГО не пишем: если
 *      администратор потом включит документооборот в интерфейсе, это его решение и следующий
 *      перезапуск его не отменит. Перезапись чужого решения на старте — тот самый класс
 *      «система молча отменила действие человека», который в проекте вычищается;
 *   3) переменной нет, СЕРВЕРНЫЙ режим (есть DOCFLOW_DATABASE_URL), на свежей базе — включаем сами;
 *   4) настройку, выставленную администратором (строка в базе уже есть), НЕ перетираем;
 *   5) локальный режим (нет базы) не трогаем: там документооборот выключен по определению.
 */
export type DocflowStartupOutcome =
  | "enabled_by_env"
  | "disabled_by_env"
  | "enabled_fresh_server"
  | "explicit_setting"
  | "not_server_mode";

export interface DocflowStartupOptions {
  /** Задан ли адрес базы документооборота (DOCFLOW_DATABASE_URL) — это и есть серверный режим. */
  serverDatabase: boolean;
  /** Значение MAILSENSE_DOCFLOW_ENABLED; undefined/пусто — переменная не задана. */
  envValue?: string | null;
  /** Текущее значение настройки docflow.enabled: null — строки в базе ещё нет. */
  readSetting?: () => Promise<string | null>;
  /** Записать настройку. */
  writeSetting?: (enabled: boolean) => Promise<void>;
}

/** true/false/1/0/да/нет — то, что человек реально пишет в .env. Мусор — undefined. */
export function parseDocflowEnabledEnv(raw: string | null | undefined): boolean | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (["true", "1", "yes", "да", "вкл"].includes(value)) return true;
  if (["false", "0", "no", "нет", "выкл"].includes(value)) return false;
  return undefined;
}

export async function applyDocflowStartupPolicy(opts: DocflowStartupOptions): Promise<DocflowStartupOutcome> {
  const fromEnv = parseDocflowEnabledEnv(opts.envValue);
  const envGiven = (opts.envValue ?? "").trim() !== "";

  // Локальный режим: базы нет, включать нечего и некуда. Но если оператор задал переменную —
  // скажем прямо, что она здесь не действует: молчаливое игнорирование настройки хуже.
  if (!opts.serverDatabase) {
    if (envGiven) {
      logger.warn(
        { value: opts.envValue },
        "MAILSENSE_DOCFLOW_ENABLED задан, но базы документооборота нет (нет DOCFLOW_DATABASE_URL) — " +
          "переменная не действует, приложение работает как почтовый клиент"
      );
    }
    return "not_server_mode";
  }

  if (envGiven && fromEnv === undefined) {
    logger.warn(
      { value: opts.envValue },
      "MAILSENSE_DOCFLOW_ENABLED не распознан (ожидается true или false) — переменная пропущена"
    );
  } else if (fromEnv === true) {
    await (opts.writeSetting ?? setDocflowEnabled)(true);
    logger.info(
      { enabled: true, source: "MAILSENSE_DOCFLOW_ENABLED" },
      "Документооборот включён переменной MAILSENSE_DOCFLOW_ENABLED"
    );
    return "enabled_by_env";
  } else if (fromEnv === false) {
    // ⚠️ Ничего не пишем: переменная лишь подавляет автовключение. Настройка администратора
    // (если она есть) остаётся его решением, а снятие переменной вернёт автовключение.
    logger.info(
      { enabled: false, source: "MAILSENSE_DOCFLOW_ENABLED" },
      "Автовключение документооборота подавлено переменной MAILSENSE_DOCFLOW_ENABLED — сервер работает только с почтой"
    );
    return "disabled_by_env";
  }

  const current = await (opts.readSetting ?? (() => getSetting(SETTING_DOCFLOW_ENABLED)))();
  if (current !== null) {
    logger.info(
      { enabled: current === "true" },
      "Документооборот настроен администратором — автовключение не применяется"
    );
    return "explicit_setting";
  }

  await (opts.writeSetting ?? setDocflowEnabled)(true);
  logger.info(
    "Свежее серверное развёртывание: документооборот включён автоматически — теперь работает вход, а API закрыт аутентификацией"
  );
  return "enabled_fresh_server";
}
