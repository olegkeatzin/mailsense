export interface AttachmentLike {
  id: string;
  filename: string;
}

export interface AttachmentDescription {
  name: string;
  description: string;
}

/** Нормализация имени файла: basename, нижний регистр, схлопнутые пробелы. */
function normalizeName(name: string): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^.*[\\/]/, "")
    .replace(/\s+/g, " ");
}

/** Имя без расширения (для сопоставления «1575.pdf» ↔ «№1575 от 24.07.2026.pdf»). */
function stem(name: string): string {
  return normalizeName(name).replace(/\.[a-z0-9]{1,8}$/, "");
}

/**
 * Сопоставляет описания вложений из ответа ИИ-модели с реальными вложениями письма.
 *
 * Модель иногда возвращает имя с другим регистром, лишними пробелами, путём или
 * усечённым расширением — из-за строгого сравнения по `filename` описание терялось
 * и вложение оставалось без «краткого содержания». Сравниваем по шагам:
 * точное имя → регистронезависимое → нормализованное → основа без расширения →
 * вхождение подстроки (не короче 3 символов, чтобы не склеивать «1»).
 *
 * Возвращает Map<attachmentId, description> (одно описание на вложение).
 */
export function matchAttachmentDescriptions(
  attachments: AttachmentLike[],
  descriptions: AttachmentDescription[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (const d of descriptions ?? []) {
    const name = (d?.name ?? "").trim();
    const description = (d?.description ?? "").trim();
    if (!description) continue;

    const exact = attachments.find((a) => a.filename === name);
    const ci = exact ?? attachments.find((a) => normalizeName(a.filename) === normalizeName(name));
    const n = normalizeName(name);
    const ns = stem(name);
    const loose =
      ci ??
      attachments.find((a) => {
        const an = normalizeName(a.filename);
        const as = stem(a.filename);
        if (an === n || (ns && as && ns === as)) return true;
        return (
          (n.length >= 3 && an.includes(n)) ||
          (an.length >= 3 && n.includes(an)) ||
          (ns.length >= 3 && as.includes(ns)) ||
          (as.length >= 3 && ns.includes(as))
        );
      });

    if (loose && !result.has(loose.id)) result.set(loose.id, description);
  }
  return result;
}
