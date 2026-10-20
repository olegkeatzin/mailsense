/**
 * Кто из письма-ответа становится исполнителем.
 *
 * Заказчик: руководитель может ответить из Outlook, и тогда исполнители — те, кого он
 * поставил в получатели и копию; наш служебный ящик и он сам исполнителями не считаются.
 * Функция чистая: без базы и без почты, чтобы поведение проверялось тестами напрямую.
 */
export function executorsFromReply(input: {
  from: string;
  to: Array<{ address: string; name?: string }>;
  cc: Array<{ address: string; name?: string }>;
  /** Наши адреса (служебный ящик, с которого ушёл запрос). */
  exclude: string[];
}): Array<{ address: string; name: string }> {
  const skip = new Set(
    [input.from, ...input.exclude]
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
  );
  const out = new Map<string, { address: string; name: string }>();
  for (const a of [...input.to, ...input.cc]) {
    const address = (a.address ?? "").trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (skip.has(key) || out.has(key)) continue;
    out.set(key, { address, name: (a.name ?? "").trim() });
  }
  return [...out.values()];
}
