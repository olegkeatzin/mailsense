import { eq } from "drizzle-orm";
import { getDocflowDb, docflowSchema } from "./db/index.js";

/**
 * Настройки серверной части. Лежат в её собственной базе (PostgreSQL),
 * а не в настройках почтового клиента — у этих частей разный жизненный цикл.
 * Настройки каталога (ldap.*) остаются общими: каталог нужен и адресной книге почты.
 */
const { settings } = docflowSchema;

export async function getSetting(key: string): Promise<string | null> {
  const rows = await getDocflowDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0] ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDocflowDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function listSettings(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of await getDocflowDb().select().from(settings)) out[row.key] = row.value;
  return out;
}
