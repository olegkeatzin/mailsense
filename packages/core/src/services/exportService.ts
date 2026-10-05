import * as XLSX from "xlsx";

/**
 * Выгрузка табличных данных в Excel.
 *
 * Универсально: ядро не знает ни про журнал, ни про аудит — ему передают колонки
 * и строки. Так экспорт можно переиспользовать для любой серверной выгрузки.
 */
export interface ExportColumn {
  /** Ключ в объекте строки. */
  key: string;
  /** Заголовок колонки в файле. */
  title: string;
  /** Ширина колонки в символах. */
  width?: number;
}

/** Значение ячейки: null и undefined превращаются в пустую строку, а не в «null». */
function cell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function buildXlsx(options: {
  sheetName?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
}): Buffer {
  const header = options.columns.map((c) => c.title);
  const body = options.rows.map((r) => options.columns.map((c) => cell(r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);

  const widths = options.columns.map((c) => ({
    // Минимум по заголовку: иначе «№» и «Дата» сожмутся в нечитаемое.
    wch: Math.max(c.width ?? 12, c.title.length + 2)
  }));
  ws["!cols"] = widths;

  const wb = XLSX.utils.book_new();
  // Имя листа в Excel ограничено 31 символом и не терпит : \ / ? * [ ].
  const raw = options.sheetName ?? "Лист1";
  const safe = raw.replace(/[:\\/?*\[\]]/g, " ").slice(0, 31) || "Лист1";
  XLSX.utils.book_append_sheet(wb, ws, safe);

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Имя файла выгрузки: «journal-2026-10-03.xlsx». */
export function exportFileName(prefix: string, date: Date = new Date()): string {
  const p = (n: number): string => (n < 10 ? "0" + n : String(n));
  return prefix + "-" + date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) + ".xlsx";
}