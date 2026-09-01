import * as XLSX from "xlsx";
import { xlsxToText } from "./xlsx.js";

describe("xlsxToText", () => {
  test("извлекает листы как CSV с заголовком листа", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Имя", "Сумма"],
      ["Иванов", 100],
      ["Петров", 200]
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Счёт");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const text = xlsxToText(buf);
    expect(text).toContain("=== Счёт ===");
    expect(text).toContain("Иванов");
    expect(text).toContain("100");
    expect(text).toContain("Петров");
  });
});
