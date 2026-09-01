import * as XLSX from "xlsx";

export function xlsxToText(data: Buffer, maxSheets = 10): string {
  const wb = XLSX.read(data, { type: "buffer" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames.slice(0, maxSheets)) {
    const ws = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    parts.push("=== " + sheetName + " ===\n" + csv);
  }
  return parts.join("\n\n");
}
