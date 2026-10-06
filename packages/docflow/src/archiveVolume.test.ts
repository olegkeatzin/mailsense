import {
  archiveFailureText,
  formatArchiveSize,
  sumAttachmentBytes,
  type SizedAttachment
} from "./archiveVolume.js";

/**
 * Оценка объёма вложений года и текст отказа при неудачном снимке.
 *
 * Предупреждения о пределе 4 ГБ здесь больше нет: архив поддерживает Zip64, предел снят,
 * и предупреждать о несуществующем пределе было бы враньём (решение Lead).
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

    const res = await sumAttachmentBytes({ links: endless, store, limitBytes: 3 * GiB });

    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeGreaterThanOrEqual(3 * GiB);
    // Двух писем по 2 ГБ хватило: тысячу писем не читаем.
    expect(consumed).toBe(2);
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  test("досрочный выход важнее неизвестных размеров: превышение известно точно", async () => {
    const store = {
      list: jest.fn(async () => [
        { name: "без-размера.bin" },
        { name: "огромный.bin", size: 5 * GiB }
      ])
    };

    // Предел передан явно: предела по умолчанию больше нет — он был частью снятого
    // предупреждения о 4 ГБ. Механизм досрочного выхода при явном пределе остался.
    const res = await sumAttachmentBytes({ links: links(["e-1"]), store, limitBytes: 4 * GiB });

    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(5 * GiB);
  });
});