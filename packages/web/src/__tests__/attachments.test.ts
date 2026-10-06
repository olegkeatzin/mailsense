import { attachmentBase64, bytesToBase64, materializeAttachments, type ComposerAttachment } from "../api";

/**
 * Вложения окна письма. Шаблон пересылки больше не несёт данных: в нём только ссылка
 * на файл письма, а base64 получается в момент отправки/сохранения черновика.
 * Ошибка здесь — тихая потеря вложения: человек видит файл, а письмо уходит без него.
 */

const decode = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

describe("bytesToBase64", () => {
  it("кодирует кириллицу побайтово, а не посимвольно", () => {
    const bytes = new TextEncoder().encode("Договор.pdf");
    expect(decode(bytesToBase64(bytes))).toBe("Договор.pdf");
  });

  it("большой файл кодируется без переполнения стека", () => {
    // 300 000 байт: String.fromCharCode(...bytes) одним куском на таком размере падает.
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const base64 = bytesToBase64(bytes);

    expect(base64.length).toBe(Math.ceil(bytes.length / 3) * 4);
    const back = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back[0]).toBe(0);
    expect(back[299_999]).toBe(299_999 % 251);
  });
});

describe("attachmentBase64", () => {
  it("тянет файл с cookie сессии и кодирует байты", async () => {
    const bytes = new TextEncoder().encode("PDF-данные");
    const fetchMock = jest.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }));
    jest.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const base64 = await attachmentBase64("e-1", "a-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Тот же маршрут, что и у скачивания вложения из письма: ничего нового не заводим.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/emails/e-1/attachments/a-1/file");
    expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: "include" });
    expect(decode(base64)).toBe("PDF-данные");
  });

  it("отказ сервера доходит до человека текстом из ответа", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      statusText: "Not Found",
      json: async () => ({ error: "Файл не найден" })
    } as unknown as Response);

    await expect(attachmentBase64("e-1", "a-1")).rejects.toThrow("Файл не найден");
  });

  it("ответ без JSON не превращается в пустое сообщение", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("не JSON");
      }
    } as unknown as Response);

    await expect(attachmentBase64("e-1", "a-1")).rejects.toThrow("Bad Gateway");
  });
});

describe("materializeAttachments", () => {
  const ref = { emailId: "e-1", attachmentId: "a-1" };
  const refItem: ComposerAttachment = {
    filename: "Договор (копия).pdf",
    mimeType: "application/pdf",
    size: 1024,
    ref
  };

  it("ссылку из шаблона тянет по требованию и подставляет данные", async () => {
    const load = jest.fn(async () => "QQ==");

    const out = await materializeAttachments([refItem], load);

    expect(load).toHaveBeenCalledWith("e-1", "a-1");
    expect(out).toEqual([
      { filename: "Договор (копия).pdf", mimeType: "application/pdf", size: 1024, data: "QQ==" }
    ]);
  });

  it("уже загруженные данные повторно не тянет", async () => {
    const load = jest.fn(async () => "QQ==");

    // Вложение, которое человек выбрал сам или которое пришло из черновика.
    const out = await materializeAttachments([{ ...refItem, data: "Zg==" }], load);

    expect(load).not.toHaveBeenCalled();
    expect(out[0].data).toBe("Zg==");
  });

  it("файл не пришёл — ошибка с именем вложения, а не письмо без файла", async () => {
    const load = jest.fn(async () => {
      throw new Error("Файл не найден");
    });

    await expect(materializeAttachments([refItem], load)).rejects.toThrow(
      /Договор \(копия\)\.pdf.*Файл не найден/
    );
  });

  it("вложение без данных и без ссылки не отправляется молча", async () => {
    const broken = { filename: "акт.pdf", mimeType: "application/pdf", size: 10 } as ComposerAttachment;

    await expect(materializeAttachments([broken])).rejects.toThrow(/акт\.pdf/);
  });

  it("два вложения с одинаковым именем остаются двумя", async () => {
    const load = jest.fn(async (_emailId: string, attachmentId: string) =>
      attachmentId === "a-1" ? "QQ==" : "Qg=="
    );

    const out = await materializeAttachments(
      [refItem, { ...refItem, ref: { emailId: "e-1", attachmentId: "a-2" } }],
      load
    );

    expect(out.map((a) => a.data)).toEqual(["QQ==", "Qg=="]);
    expect(out.map((a) => a.filename)).toEqual(["Договор (копия).pdf", "Договор (копия).pdf"]);
  });

  it("нулевой размер считается по данным", async () => {
    const out = await materializeAttachments([{ ...refItem, size: 0, data: "QUJD" }], jest.fn());

    expect(out[0].size).toBe(3);
  });
});
