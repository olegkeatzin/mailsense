import { setLdapSettingsStore, type LdapSettingsStore } from "@mailsense/core/directory";
import { logger } from "@mailsense/core/directory";
import { listSettings, setSetting } from "./settings.js";

/**
 * Настройки каталога в PostgreSQL.
 *
 * Каталог — инфраструктура предприятия: адрес контроллера домена, Base DN и форматы
 * логина задаёт администратор на сервере. Пользователю остаётся ввести только свой
 * логин и пароль. Иначе каждый мог бы указать произвольный каталог и подменить
 * адресную книгу (подсунуть чужие адреса в автодополнение).
 *
 * Чтение синхронное — core дёргает настройки в горячих путях (поиск контактов),
 * поэтому значения держим в памяти, а в базу пишем при изменении.
 */
function createStore(initial: Record<string, string>): LdapSettingsStore {
  let cache: Record<string, string> = { ...initial };
  return {
    read() {
      return cache;
    },
    async write(values) {
      for (const [key, value] of Object.entries(values)) await setSetting(key, value);
      cache = { ...cache, ...values };
    }
  };
}

/**
 * Делает сервер владельцем настроек каталога.
 *
 * Значения берутся ТОЛЬКО из базы предприятия и никогда — из локального файла:
 * база наполняется осознанным действием администратора. Иначе локальные значения
 * «повышались» бы до корпоративных — это та же подмена каталога, от которой уходим.
 */
export async function installLdapSettingsStore(): Promise<void> {
  const all = await listSettings();
  const fromDb: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("ldap.")) fromDb[key] = value;
  }
  setLdapSettingsStore(createStore(fromDb));

  if (!fromDb["ldap.url"]) {
    logger.warn(
      "Каталог не настроен. Задайте адрес и Base DN в «Настройки → Каталог (LDAP)» на сервере — " +
        "без этого вход в систему невозможен"
    );
  }
}
