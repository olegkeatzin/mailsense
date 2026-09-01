const { createCanvas } = require("@napi-rs/canvas");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const fs = require("fs");
const path = require("path");

const outDir = "/tmp/attachments";
fs.mkdirSync(outDir, { recursive: true });

// 1. PNG
const canvas = createCanvas(520, 280);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 520, 280);
ctx.fillStyle = "#111111"; ctx.font = "bold 26px sans-serif";
ctx.fillText("СЧЁТ-ФАКТУРА № 3452", 30, 70);
ctx.fillStyle = "#333333"; ctx.font = "20px sans-serif";
ctx.fillText("Сумма: 1 250 000 руб.", 30, 120);
ctx.fillText("Срок оплаты: 30.08.2026", 30, 160);
const png = canvas.toBuffer("image/png");
fs.writeFileSync(path.join(outDir, "invoice.png"), png);

// 2. XLSX
const ws = XLSX.utils.aoa_to_sheet([
  ["Наименование", "Кол-во", "Цена, руб"],
  ["Сервер Dell R750", 5, 250000],
  ["Итого", "", 1250000]
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Смета");
fs.writeFileSync(path.join(outDir, "estimate.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

function buildPdf() {
  const stream = "BT /F1 22 Tf 80 700 Td (Agreement terms: payment deadline 01.10.2026, amount 150000 rub) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) { offsets.push(pdf.length); pdf += (i + 1) + " 0 obj\n" + objs[i] + "\nendobj\n"; }
  const xref = pdf.length;
  pdf += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(pdf, "latin1");
}

(async () => {
  // 3. DOCX (text + embedded png)
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder("_rels").file(".rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder("word").file("document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Договор поставки оборудования № 77. Общая сумма 2 000 000 руб. Подписать до 15.09.2026.</w:t></w:r></w:p></w:body></w:document>');
  zip.folder("word/media").file("image1.png", png);
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(path.join(outDir, "contract.docx"), docx);

  // 4. PDF
  fs.writeFileSync(path.join(outDir, "agreement.pdf"), buildPdf());

  console.log("generated:", fs.readdirSync(outDir).join(", "));
})();
