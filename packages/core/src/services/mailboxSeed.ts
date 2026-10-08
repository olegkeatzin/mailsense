import { logger } from "../logger.js";
import { getAccountByUsername, insertAccount } from "../repos.js";
import type { Config, MailboxConfig } from "../config.js";
import type { SecretStore } from "../secrets.js";
import type { AccountInput } from "../types.js";

/**
 * Засев почтовых ящиков из окружения (MAILSENSE_MAILBOXES): контейнер разворачивается
 * целиком из .env, без захода в интерфейс.
 *
 * Правила:
 * • создаём ТОЛЬКО отсутствующие ящики (сравнение по адресу, регистр не важен).
 *   Существующий НЕ перезаписываем: пароль могли поменять в интерфейсе, и затирать
 *   его при каждом перезапуске контейнера — значит ломать рабочую настройку;
 * • пароль шифруем тем же механизмом, что интерфейс (ключ из data/), открытый текст в базу не пишем;
 * • один плохой элемент не роняет остальные: ошибка попадает в сводку и журнал, цикл идёт дальше.
 */

export interface MailboxSeedReport {
  created: number;
  skipped: number;
  failed: number;
}

/** Сводку логирует и серверная часть (она видит её из initApp). */
export function seedMailboxes(
  config: Pick<Config, "mailboxes" | "mailboxErrors" | "mailboxWarnings">,
  secrets: SecretStore
): MailboxSeedReport {
  const report: MailboxSeedReport = { created: 0, skipped: 0, failed: 0 };

  // Причины пропуска, найденные при разборе переменной: считаем их отказами.
  for (const reason of config.mailboxErrors ?? []) {
    report.failed++;
    logger.warn("Ящик из MAILSENSE_MAILBOXES пропущен: " + reason);
  }

  // Неизвестные поля: ящик создаётся, но о возможной опечатке говорим громко — иначе
  // настройка тихо не применится, и причину будут искать в другом месте.
  for (const warning of config.mailboxWarnings ?? []) {
    logger.warn("Ящик из MAILSENSE_MAILBOXES: " + warning);
  }

  for (const mb of config.mailboxes ?? []) {
    try {
      // Даже если разбор уже проверял поля, защищаемся здесь: ящик без адреса или пароля
      // в базе бесполезен и потом путает интерфейс.
      if (!mb.username?.trim()) throw new Error("не указан адрес ящика");
      if (!mb.password) throw new Error("не указан пароль");

      const existing = getAccountByUsername(mb.username);
      if (existing) {
        report.skipped++;
        logger.info({ username: existing.username }, "Ящик из окружения уже есть — не перезаписываем");
        continue;
      }

      insertAccount(toAccountInput(mb), secrets.encrypt(mb.password), mb.smtpPassword ? secrets.encrypt(mb.smtpPassword) : null);
      report.created++;
      logger.info({ username: mb.username }, "Ящик из окружения создан");
    } catch (err) {
      report.failed++;
      logger.warn({ username: mb.username, err: (err as Error).message }, "Не удалось создать ящик из окружения");
    }
  }

  return report;
}

function toAccountInput(mb: MailboxConfig): AccountInput {
  return {
    protocol: mb.protocol,
    host: mb.host,
    port: mb.port,
    tls: mb.tls,
    username: mb.username.trim(),
    authType: mb.authType,
    smtpHost: mb.smtpHost ?? null,
    smtpPort: mb.smtpPort ?? null,
    smtpTls: mb.smtpTls ?? null,
    smtpUsername: mb.smtpUsername ?? null,
    smtpPassword: mb.smtpPassword ?? null
  };
}
