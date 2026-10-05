import { isMboxData, isMboxFilename, splitMbox } from "./mbox.js";

/**
 * mbox — формат экспорта Thunderbird. Разбор простой, но ошибка в разделителе
 * молча склеивает или рвёт письма, поэтому проверяем краевые случаи.
 */
describe("определение формата", () => {
  test("по расширению файла", () => {
    expect(isMboxFilename("archive.mbox")).toBe(true);
    expect(isMboxFilename("ARCHIVE.MBOX")).toBe(true);
    expect(isMboxFilename("mail.eml")).toBe(false);
  });

  test("по содержимому: разделитель «From » отличается от заголовка «From:»", () => {
    expect(isMboxData(Buffer.from("From sender@test.local Mon Jan  1 00:00:00 2026\n"))).toBe(true);
    // «From:» — обычный заголовок письма, а не разделитель mbox.
    expect(isMboxData(Buffer.from("From: sender@test.local\nSubject: hi\n"))).toBe(false);
    expect(isMboxData(Buffer.from(""))).toBe(false);
  });
});

describe("разбор сообщений", () => {
  test("несколько писем делятся по разделителю", () => {
    const data = Buffer.from(
      [
        "From a@test.local Mon Jan  1 00:00:00 2026",
        "Subject: Первое",
        "",
        "тело 1",
        "From b@test.local Tue Jan  2 00:00:00 2026",
        "Subject: Второе",
        "",
        "тело 2"
      ].join("\n")
    );
    const parts = splitMbox(data);
    expect(parts).toHaveLength(2);
    expect(parts[0].toString()).toContain("Первое");
    expect(parts[0].toString()).not.toContain("Второе");
    expect(parts[1].toString()).toContain("Второе");
  });

  test("строка «>From » в теле разэкранируется — иначе текст портится", () => {
    const data = Buffer.from(
      ["From a@test.local Mon Jan  1 00:00:00 2026", "Subject: Цитата", "", ">From это цитата в теле"].join("\n")
    );
    const parts = splitMbox(data);
    expect(parts).toHaveLength(1);
    // Разэкранирование — по стандарту mbox; при этом письмо остаётся одним.
    expect(parts[0].toString()).toContain("From это цитата в теле");
    expect(parts[0].toString()).not.toContain(">From это цитата");
  });

  test("без завершающего разделителя последнее письмо не теряется", () => {
    const data = Buffer.from(["From a@test.local Mon Jan  1 00:00:00 2026", "Subject: Одно", "", "тело"].join("\n"));
    expect(splitMbox(data)).toHaveLength(1);
  });

  test("пустой ввод даёт пустой список", () => {
    expect(splitMbox(Buffer.from(""))).toHaveLength(0);
  });

  test("текст до первого разделителя не превращается в письмо", () => {
    const data = Buffer.from(["мусор до разделителя", "From a@test.local Mon Jan  1 00:00:00 2026", "Subject: X"].join("\n"));
    const parts = splitMbox(data);
    expect(parts).toHaveLength(1);
    expect(parts[0].toString()).not.toContain("мусор");
  });
});
