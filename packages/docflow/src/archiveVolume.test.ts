import {
  ARCHIVE_DANGER_BYTES,
  ARCHIVE_LIMIT_BYTES,
  ARCHIVE_WARN_BYTES,
  archiveFailureText,
  archiveVolumeWarning,
  formatArchiveSize,
  sumAttachmentBytes,
  type SizedAttachment
} from "./archiveVolume.js";

/**
 * Предупреждение о пределе архива считается ДО закрытия года.
 *
 * Смысл проверок: текст обязан (а) появляться вовремя, (б) не врать про размер,
 * (в) в отказе прямо говорить, что год НЕ закрыт. Плюс подсчёт не должен открывать файлы
 * и не должен читать весь год, если предел уже превышен.
 */
const GiB = 1024 ** 3;

/** Тот же обход ссылок, что у выгрузки: год → письма документов. */
function links(ids: string[]): AsyncIterable<{ emailId: string }> {
  return (async function* () {
    for (const id of ids) yield { emailId: id };
  })();
}

describe("размер для человека", () => {
  test("гигабайты с запятой, без зависимости от локали процесса", () => {
    expect(formatArchiveSize(3 * GiB)).toBe("3,0 ГБ");
    expect(formatArchiveSize(3.24 * GiB)).toBe("3,2 ГБ");
    expect(formatArchiveSize(0)).toBe("0,0 ГБ");
  });
});

describe("предупреждение о пределе архива", () => {
  test("ниже 3 ГБ — молчим: предупреждение на каждый год обесценивает себя", () => {
    expect(archiveVolumeWarning(ARCHIVE_WARN_BYTES - 1, "2026")).toEqual({ level: "ok", text: null });
  });

  test("ровно 3 ГБ — уже предупреждаем (граница включительно)", () => {
    const w = archiveVolumeWarning(ARCHIVE_WARN_BYTES, "2026");
    expect(w.level).toBe("near");
    expect(w.text).toContain("3,0 ГБ");
    expect(w.text).toContain("2026");
  });

  test("в «near» есть и размер, и что случится, и что делать", () => {
    const w = archiveVolumeWarning(3.2 * GiB, "2026");
    expect(w.level).toBe("near");
    expect(w.text).toContain("≈3,2 ГБ");
    expect(w.text).toContain("не поддерживает файлы больше 4 ГБ");
    expect(w.text).toContain("год останется открытым");
    expect(w.text).toContain("Освободите объём");
  });

  test("3,5 ГБ — «скорее всего, не удастся», и сказано, что данные не изменятся", () => {
    const w = archiveVolumeWarning(ARCHIVE_DANGER_BYTES, "2026");
    expect(w.level).toBe("over");
    expect(w.text).toContain("не удастся");
    expect(w.text).toContain("год останется открытым — данные журнала не изменятся");
  });

  test("выше предела — по-прежнему «over», без выдуманных цифр", () => {
    const w = archiveVolumeWarning(5 * GiB, "2026");
    expect(w.level).toBe("over");
    expect(w.text).toContain("≈5,0 ГБ");
  });

  test("при досрочном выходе сумма — нижняя граница: «не менее», а не «≈»", () => {
    // Иначе при вложениях на 10 ГБ форма показала бы «≈4,0 ГБ» — враньё в меньшую сторону.
    const w = archiveVolumeWarning(ARCHIVE_LIMIT_BYTES, "2026", { truncated: true });
    expect(w.level).toBe("over");
    expect(w.text).toContain("не менее 4,0 ГБ");
    expect(w.text).not.toContain("≈4,0 ГБ");
  });

  test("без года текст остаётся читаемым", () => {
    const w = archiveVolumeWarning(3.6 * GiB, null);
    expect(w.text).toContain("Закрыть год, скорее всего, не удастся");
  });
});

describe("текст отказа после нажатия", () => {
  test("прямо говорит: год НЕ закрыт, и повторяет причину", () => {
    const t = archiveFailureText("нет места на диске");
    expect(t).toContain("год НЕ закрыт");
    expect(t).toContain("нет места на диске");
    expect(t).toContain("Данные журнала не изменялись");
  });

  test("пустая причина не оставляет «Причина: .»", () => {
    const t = archiveFailureText("   ");
    expect(t).not.toContain("Причина: .");
    expect(t).toContain("выгрузка архива не удалась");
  });
});

describe("подсчёт объёма вложений", () => {
  test("суммирует размеры из метаданных и НЕ открывает файлы", async () => {
    const openSpy = jest.fn(() => {
      throw new Error("файл открывать нельзя: считаем по метаданным");
    });
    const store = {
      list: jest.fn(async () => [
        { name: "акт.pdf", size: 100, open: openSpy } as unknown as SizedAttachment,
        { name: "счёт.pdf", size: 250, open: openSpy } as unknown as SizedAttachment
      ])
    };

    const res = await sumAttachmentBytes({ links: links(["e-1"]), store });

    expect(res).toEqual({ bytes: 350, files: 2, unknownSizes: 0, truncated: false });
    expect(openSpy).not.toHaveBeenCalled();
  });

  test("размер неизвестен — предупреждать нечем, возвращаем null", async () => {
    const store = { list: jest.fn(async () => [{ name: "акт.pdf" }, { name: "счёт.pdf", size: 10 }]) };

    const res = await sumAttachmentBytes({ links: links(["e-1"]), store });

    expect(res.bytes).toBeNull();
    expect(res.unknownSizes).toBe(1);
    expect(res.files).toBe(2);
  });

  test("недоступное письмо пропускается — как в выгрузке, а не роняет подсчёт", async () => {
    const store = {
      list: jest.fn(async (emailId: string) => {
        if (emailId === "bad") throw new Error("письмо удалено");
        return [{ name: "акт.pdf", size: 10 }];
      })
    };

    const res = await sumAttachmentBytes({ links: links(["bad", "e-2"]), store });

    expect(res.bytes).toBe(10);
    expect(res.files).toBe(1);
  });

  test("предел превышен — обход прекращается досрочно", async () => {
    let consumed = 0;
    const endless: AsyncIterable<{ emailId: string }> = (async function* () {
      for (let i = 0; i < 1000; i += 1) {
        consumed += 1;
        yield { emailId: "e-" + i };
      }
    })();
    const store = { list: jest.fn(async () => [{ name: "big.bin", size: 2 * GiB }]) };

    const res = await sumAttachmentBytes({ links: endless, store, limitBytes: ARCHIVE_LIMIT_BYTES });

    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeGreaterThanOrEqual(ARCHIVE_LIMIT_BYTES);
    // Двух писем по 2 ГБ хватило: тысячу писем не читаем.
    expect(consumed).toBe(2);
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  test("ровно предел — это уже «не влезает»: архив обязан быть МЕНЬШЕ 4 ГБ", async () => {
    const store = { list: jest.fn(async () => [{ name: "ровно.bin", size: ARCHIVE_LIMIT_BYTES }]) };

    const res = await sumAttachmentBytes({ links: links(["e-1"]), store });

    expect(res.truncated).toBe(true);
    expect(archiveVolumeWarning(res.bytes as number, "2026").level).toBe("over");
  });

  test("досрочный выход важнее неизвестных размеров: превышение известно точно", async () => {
    const store = {
      list: jest.fn(async () => [
        { name: "без-размера.bin" },
        { name: "огромный.bin", size: 5 * GiB }
      ])
    };

    const res = await sumAttachmentBytes({ links: links(["e-1"]), store });

    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(5 * GiB);
    expect(archiveVolumeWarning(res.bytes as number, "2026").level).toBe("over");
  });
});