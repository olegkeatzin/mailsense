import * as XLSX from "xlsx";
import JSZip from "jszip";
import { buildXlsx, exportFileName } from "./exportService.js";

/** Выгрузка в Excel: файл должен открываться и содержать то, что мы положили. */
const columns = [
  { key: "n", title: "№", width: 6 },
  { key: "date", title: "Дата", width: 12 },
  { key: "summary", title: "Краткое содержание", width: 40 }
];

function readBack(buf: Buffer): unknown[][] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][];
}

describe("выгрузка в Excel", () => {
  test("заголовки колонок попадают в первую строку", () => {
    const rows = readBack(buildXlsx({ columns, rows: [{ n: 1, date: "2026-01-01", summary: "Письмо" }] }));
    expect(rows[0]).toEqual(["№", "Дата", "Краткое содержание"]);
  });

  test("данные сохраняются без искажений", () => {
    const rows = readBack(
      buildXlsx({ columns, rows: [{ n: 7, date: "2026-05-05", summary: "Материалы к ВКС" }] })
    );
    expect(rows[1]).toEqual([7, "2026-05-05", "Материалы к ВКС"]);
  });

  test("пустые значения становятся пустыми ячейками, а не текстом «null»", () => {
    const rows = readBack(buildXlsx({ columns, rows: [{ n: 1, date: null, summary: undefined }] }));
    // Пустая ячейка остаётся пустой строкой — текст «null» в журнале недопустим.
    expect(rows[1][1] ?? "").toBe("");
    expect(JSON.stringify(rows[1])).not.toContain("null");
  });

  test("пустой список даёт файл с одними заголовками", () => {
    const rows = readBack(buildXlsx({ columns, rows: [] }));
    expect(rows).toHaveLength(1);
  });

  test("имя листа применяется и чистится от запрещённых символов", () => {
    const buf = buildXlsx({ sheetName: "Журнал/2026", columns, rows: [] });
    const wb = XLSX.read(buf, { type: "buffer" });
    // Слэш в имени листа Excel не допускает — иначе файл не откроется.
    expect(wb.SheetNames[0]).toBe("Журнал 2026");
  });

  test("слишком длинное имя листа обрезается до 31 символа", () => {
    const buf = buildXlsx({ sheetName: "О".repeat(60), columns, rows: [] });
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames[0].length).toBe(31);
  });

  /**
   * Ширины колонок читаются только из самого файла: community-сборка xlsx
   * не восстанавливает !cols при чтении, но в книгу их пишет (проверено по XML).
   */
  async function sheetXml(buf: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buf);
    return zip.file("xl/worksheets/sheet1.xml")!.async("string");
  }

  test("ширина колонок записывается в файл", async () => {
    const xml = await sheetXml(buildXlsx({ columns, rows: [] }));
    expect(xml).toContain("<cols>");
    expect(xml).toMatch(/width="40/);
    expect(xml).toContain('customWidth="1"');
  });

  test("узкая колонка расширяется под заголовок", async () => {
    const xml = await sheetXml(
      buildXlsx({ columns: [{ key: "x", title: "Очень длинный заголовок", width: 3 }], rows: [] })
    );
    const width = Number(xml.match(/width="([\d.]+)"/)![1]);
    expect(width).toBeGreaterThan(3);
  });

  test("кириллица и даты переносятся", () => {
    const rows = readBack(
      buildXlsx({ columns, rows: [{ n: 1, date: new Date("2026-02-03T00:00:00Z"), summary: "Ёлка «Новый год»" }] })
    );
    expect(rows[1][2]).toBe("Ёлка «Новый год»");
    expect(String(rows[1][1])).toContain("2026-02-03");
  });
});

describe("имя файла выгрузки", () => {
  test("содержит дату и расширение", () => {
    expect(exportFileName("journal", new Date("2026-10-03T12:00:00"))).toBe("journal-2026-10-03.xlsx");
  });

  test("месяц и день дополняются нулём", () => {
    expect(exportFileName("audit", new Date("2026-01-05T12:00:00"))).toBe("audit-2026-01-05.xlsx");
  });
});