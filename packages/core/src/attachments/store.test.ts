import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Хранилище вложений на диске. Найденный дефект: путь собирался из каталога
 * письма и имени файла без уникализации, поэтому два вложения с одинаковым именем
 * в одном письме затирали друг друга — в базе две записи, а на диске один файл
 * (потеря вложения, которое видно в списке, но не открывается).
 */
import { sanitizeFilename, saveAttachmentFile } from "./store.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-att-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

describe("sanitizeFilename", () => {
  test("отбрасывает путь и опасные символы", () => {
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("..");
    const safe = sanitizeFilename("акт:1?.pdf");
    expect(safe).toBe("акт_1_.pdf");
    expect(safe).not.toMatch(/[:?]/);
  });

  test("кириллица в имени сохраняется читаемой", () => {
    // Иначе «акт выполненных работ.pdf» превращался в «____________.pdf»:
    // вложение в списке называется по-русски, а на диске не найти.
    expect(sanitizeFilename("акт выполненных работ.pdf")).toBe("акт_выполненных_работ.pdf");
    expect(sanitizeFilename("Акт №5.pdf")).toBe("Акт_5.pdf");
    // Знаки препинания заменяются подчёркиванием, а не выкидываются вместе с буквами.
    expect(sanitizeFilename("скан(1).pdf")).toBe("скан_1_.pdf");
    // Другие алфавиты тоже не должны обессмысливаться.
    expect(sanitizeFilename("Änderung-2026.docx")).toBe("Änderung-2026.docx");
  });

  test("опасные имена по-прежнему обезвреживаются", () => {
    // Точки-обманки проходят basename и не содержат запрещённых символов,
    // поэтому их нужно отсекать отдельно: «..» указывает на каталог выше.
    expect(sanitizeFilename("..")).toBe("_");
    expect(sanitizeFilename(".")).toBe("_");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("злой/путь/файл.pdf")).toBe("файл.pdf");
    expect(sanitizeFilename("акт" + String.fromCharCode(0) + ".pdf")).toBe("акт_.pdf");
    expect(sanitizeFilename("док*?<>|.pdf")).toBe("док_.pdf");
  });

  test("пустое имя получает запасное", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("///")).toBe("attachment");
  });

  test("имена устройств Windows уводятся подчёркиванием", () => {
    // Файл с таким именем Windows создать не даёт — даже с расширением:
    // «CON.txt» для Win32 всё то же устройство CON. Без этого вложение не
    // сохранить, а письмо теряется целиком (saveAttachmentFile вызывается
    // до try в prepareAttachment).
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("nul")).toBe("_nul");
    expect(sanitizeFilename("COM1")).toBe("_COM1");
    expect(sanitizeFilename("con.pdf")).toBe("_con.pdf");
    expect(sanitizeFilename("LPT9.txt")).toBe("_LPT9.txt");
  });

  test("обычные имена не задеваются проверкой устройств", () => {
    // Ложные срабатывания дороги так же: «icon.png» и «консультация.pdf» —
    // нормальные имена, префикс им не нужен.
    expect(sanitizeFilename("icon.png")).toBe("icon.png");
    expect(sanitizeFilename("console.txt")).toBe("console.txt");
    expect(sanitizeFilename("консультация.pdf")).toBe("консультация.pdf");
    expect(sanitizeFilename("con-artist.pdf")).toBe("con-artist.pdf");
  });
});

describe("saveAttachmentFile", () => {
  test("обычное вложение лежит под своим именем", () => {
    const full = saveAttachmentFile(dir, "email-1", "akt.pdf", Buffer.from("содержимое"));
    expect(path.basename(full)).toBe("akt.pdf");
    expect(fs.readFileSync(full, "utf8")).toBe("содержимое");
  });

  test("два вложения с одним именем — два разных файла", () => {
    const first = saveAttachmentFile(dir, "email-1", "akt.pdf", Buffer.from("первый"));
    const second = saveAttachmentFile(dir, "email-1", "akt.pdf", Buffer.from("второй"));

    expect(second).not.toBe(first);
    // Оба файла на месте и каждый со своим содержимым — иначе одно письмо
    // показывает два вложения, а открывается одно и то же.
    expect(fs.readFileSync(first, "utf8")).toBe("первый");
    expect(fs.readFileSync(second, "utf8")).toBe("второй");
  });

  test("третье вложение с тем же именем тоже сохраняется", () => {
    const paths = ["1", "2", "3"].map((n) => saveAttachmentFile(dir, "email-1", "akt.pdf", Buffer.from(n)));
    expect(new Set(paths).size).toBe(3);
    expect(paths.map((p) => fs.readFileSync(p, "utf8"))).toEqual(["1", "2", "3"]);
  });

  test("имя остаётся узнаваемым: расширение и основа на месте", () => {
    saveAttachmentFile(dir, "email-1", "dogovor.docx", Buffer.from("1"));
    const second = saveAttachmentFile(dir, "email-1", "dogovor.docx", Buffer.from("2"));
    expect(path.basename(second)).toMatch(/^dogovor(-\d+)?\.docx$/);
    expect(path.extname(second)).toBe(".docx");
  });

  test("одинаковые имена в разных письмах не конфликтуют", () => {
    const a = saveAttachmentFile(dir, "email-1", "akt.pdf", Buffer.from("письмо 1"));
    const b = saveAttachmentFile(dir, "email-2", "akt.pdf", Buffer.from("письмо 2"));
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, "utf8")).toBe("письмо 1");
    expect(fs.readFileSync(b, "utf8")).toBe("письмо 2");
  });

  test("файлы не выходят за каталог письма", () => {
    const full = saveAttachmentFile(dir, "email-1", "../../вредное.pdf", Buffer.from("x"));
    expect(path.resolve(full).startsWith(path.resolve(dir, "attachments", "email-1"))).toBe(true);
    // «..» не должен увести запись в родительский каталог.
    const dots = saveAttachmentFile(dir, "email-1", "..", Buffer.from("x"));
    expect(path.resolve(dots).startsWith(path.resolve(dir, "attachments", "email-1"))).toBe(true);
  });

  test("вложение с именем устройства Windows сохраняется", () => {
    const full = saveAttachmentFile(dir, "email-1", "CON", Buffer.from("данные"));
    expect(path.basename(full)).toBe("_CON");
    expect(fs.readFileSync(full, "utf8")).toBe("данные");
  });

  test("русское имя вложения остаётся русским и на диске", () => {
    const full = saveAttachmentFile(dir, "email-1", "Акт выполненных работ.pdf", Buffer.from("данные"));
    expect(path.basename(full)).toBe("Акт_выполненных_работ.pdf");
    expect(fs.readFileSync(full, "utf8")).toBe("данные");
  });
});