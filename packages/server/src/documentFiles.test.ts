import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { documentFilePath, documentFilesFolderName, ensureDocumentFiles } from "./documentFiles.js";

const mockAttachments = [
  { filename: "Приглашение.pdf", size: 3, storagePath: "" },
  { filename: "images.png", size: 2, storagePath: "" }
];

jest.mock("@mailsense/core", () => ({
  getContext: () => ({ config: { dataDir: require("node:os").tmpdir() } }),
  listAttachments: () => mockAttachments,
  logger: { warn: jest.fn(), error: jest.fn() }
}));

describe("папка вложений документа", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-docs-"));
    process.env.MAIL_DOCS_DIR = root;
    mockAttachments[0].storagePath = path.join(root, "src-1.pdf");
    mockAttachments[1].storagePath = path.join(root, "src-2.png");
    fs.writeFileSync(mockAttachments[0].storagePath, "pdf");
    fs.writeFileSync(mockAttachments[1].storagePath, "pn");
  });

  afterEach(() => {
    delete process.env.MAIL_DOCS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("называет папку по входящему номеру, году и дате", () => {
    expect(
      documentFilesFolderName({ regNumber: "вх1", regPeriod: "2026", regDate: "2026-10-27" })
    ).toBe("вх12026_27.10.2026");
  });

  it("раскладывает вложения и не дублирует их при повторном вызове", async () => {
    const doc = {
      id: "doc-1",
      regNumber: "вх1",
      regPeriod: "2026",
      regDate: "2026-10-27",
      emailId: "mail-1"
    } as never;

    const first = await ensureDocumentFiles(doc);
    const second = await ensureDocumentFiles(doc);

    expect(first.docFilesPath).toBe(path.join(root, "вх12026_27.10.2026"));
    expect(first.files.map((f) => f.name)).toEqual(["Приглашение.pdf", "images.png"]);
    expect(second.files.map((f) => f.name)).toEqual(["Приглашение.pdf", "images.png"]);
    expect(fs.readFileSync(path.join(first.docFilesPath, "Приглашение.pdf"), "utf8")).toBe("pdf");
  });

  it("не выпускает скачивание за пределы папки карточки", () => {
    expect(documentFilePath(path.join(root, "card"), "file.pdf")).toBe(path.join(root, "card", "file.pdf"));
    expect(documentFilePath(path.join(root, "card"), "../secret")).toBeNull();
  });
});
