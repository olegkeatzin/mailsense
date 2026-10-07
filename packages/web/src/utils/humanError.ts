/**
 * Человеческое объяснение сбоя.
 *
 * Раньше на 74 экранах стояло (e as Error).message, и при обрыве сети человек видел
 * «Failed to fetch», а на 401 — «Unauthorized». Правило (аудит §1.7): сначала по-русски,
 * сырой ответ сервера — рядом в скобках. Молчать нельзя (rules §6.6), но и отдавать
 * технический английский вместо объяснения — тоже.
 */
export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!raw) return "Неизвестная ошибка";
  // Сервер уже сказал по-русски — не добавляем от себя ничего.
  if (/[а-яё]/i.test(raw)) return raw;
  const m = raw.toLowerCase();
  if (/failed to fetch|networkerror|network error|econnrefused|econnreset|err_internet|socket|timed? ?out|timeout/.test(m)) {
    return "Нет связи с сервером (" + raw + ")";
  }
  if (/\b401\b|unauthorized/.test(m)) return "Нужно войти заново (" + raw + ")";
  if (/\b403\b|forbidden/.test(m)) return "Недостаточно прав (" + raw + ")";
  if (/\b404\b|not found/.test(m)) return "Не найдено (" + raw + ")";
  if (/\b40\d\b|bad request|invalid/.test(m)) return "Сервер отклонил запрос (" + raw + ")";
  if (/\b50\d\b|bad gateway|internal server/.test(m)) return "Сервер вернул ошибку (" + raw + ")";
  return "Не удалось выполнить действие (" + raw + ")";
}
