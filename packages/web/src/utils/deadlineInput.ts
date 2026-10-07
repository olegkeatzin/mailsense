/**
 * Разбор даты, набранной человеком в поле срока.
 *
 * DatePicker применяет набранное значение только по Enter/blur, а ещё принимает лишь свой
 * формат. Подписант набрал «12.10.2026» и сразу нажал кнопку — срок уходил null, и ввод
 * терялся молча (живой дефект, нашёл QA). Поэтому на отправке мы читаем то, что реально
 * написано в поле, и разбираем сами: два привычных формата, без догадок.
 *
 * Возвращает дату в виде YYYY-MM-DD или null, если разобрать нечего/дата не существует.
 */
export function parseTypedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m = /^(\d{1,2})[.,/](\d{1,2})[.,/](\d{4})$/.exec(s);
    if (m) {
      day = Number(m[1]);
      month = Number(m[2]);
      year = Number(m[3]);
    }
  }
  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Проверяем, что такая дата существует: 31.02 не должно становиться 03.03.
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;

  const pad = (n: number) => String(n).padStart(2, "0");
  return String(year) + "-" + pad(month) + "-" + pad(day);
}
