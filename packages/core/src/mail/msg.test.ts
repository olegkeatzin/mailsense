/**
 * Разбор Outlook .msg: саму OLE2-оболочку читает @kenjiuno/msgreader, а наша
 * задача — правильно разложить её поля в общий формат письма. Библиотеку
 * подменяем (реального .msg под рукой нет), а отображение проверяем целиком.
 */
const mockGetFileData = jest.fn();
const mockGetAttachment = jest.fn();

jest.mock("@kenjiuno/msgreader", () => ({
  __esModule: true,
  default: jest.fn(() => ({ getFileData: mockGetFileData, getAttachment: mockGetAttachment }))
}));

import { parseMsg } from "./msg.js";

function fileData(over: Record<string, unknown> = {}) {
  return {
    subject: "Тема письма",
    senderName: "Отправитель",
    senderEmail: "sender@test.local",
    body: "Текст письма",
    bodyHtml: "<p>Текст письма</p>",
    messageId: "<msg-1@test.local>",
    clientSubmitTime: "2026-01-15T10:00:00.000Z",
    recipients: [],
    attachments: [],
    ...over
  };
}

beforeEach(() => {
  mockGetFileData.mockReset();
  mockGetAttachment.mockReset();
  mockGetFileData.mockReturnValue(fileData());
  mockGetAttachment.mockReturnValue({ fileName: "файл.txt", content: new Uint8Array([1, 2, 3]) });
});

describe("основные поля", () => {
  test("тема, тело и HTML переносятся", () => {
    const p = parseMsg(Buffer.from("x"));
    expect(p.subject).toBe("Тема письма");
    expect(p.bodyText).toBe("Текст письма");
    expect(p.bodyHtml).toBe("<p>Текст письма</p>");
  });

  test("Message-ID нормализуется — угловые скобки срезаются", () => {
    // В базе Message-ID хранится без скобок, иначе не сойдётся с письмами из IMAP.
    expect(parseMsg(Buffer.from("x")).messageId).toBe("msg-1@test.local");
  });

  test("без Message-ID получается пустая строка, а не «undefined»", () => {
    mockGetFileData.mockReturnValue(fileData({ messageId: undefined }));
    expect(parseMsg(Buffer.from("x")).messageId).toBe("");
  });

  test("без темы подставляется понятная заглушка", () => {
    mockGetFileData.mockReturnValue(fileData({ subject: undefined }));
    expect(parseMsg(Buffer.from("x")).subject).toBe("(без темы)");
  });

  test("отправитель с именем", () => {
    expect(parseMsg(Buffer.from("x")).from).toEqual({ name: "Отправитель", address: "sender@test.local" });
  });

  test("адрес SMTP используется, когда нет поля email", () => {
    mockGetFileData.mockReturnValue(
      fileData({ senderEmail: undefined, senderSmtpAddress: "smtp@test.local", senderName: undefined })
    );
    expect(parseMsg(Buffer.from("x")).from).toEqual({ name: undefined, address: "smtp@test.local" });
  });

  test("без отправителя поле остаётся пустым, а не пустым объектом", () => {
    mockGetFileData.mockReturnValue(fileData({ senderEmail: undefined, senderSmtpAddress: undefined }));
    expect(parseMsg(Buffer.from("x")).from).toBeNull();
  });
});

describe("получатели", () => {
  test("«кому» и «копия» разделяются по типу", () => {
    mockGetFileData.mockReturnValue(
      fileData({
        recipients: [
          { name: "Первый", email: "to1@test.local", recipType: "to" },
          { name: "Второй", email: "cc1@test.local", recipType: "cc" },
          { name: "Третий", email: "to2@test.local", recipType: "to" }
        ]
      })
    );
    const p = parseMsg(Buffer.from("x"));
    expect(p.to.map((a) => a.address)).toEqual(["to1@test.local", "to2@test.local"]);
    expect(p.cc.map((a) => a.address)).toEqual(["cc1@test.local"]);
  });

  test("получатели прочих типов (скрытая копия) не попадают в «кому»", () => {
    mockGetFileData.mockReturnValue(
      fileData({ recipients: [{ email: "bcc@test.local", recipType: "bcc" }] })
    );
    const p = parseMsg(Buffer.from("x"));
    expect(p.to).toEqual([]);
    expect(p.cc).toEqual([]);
  });

  test("адрес получателя берётся из smtpAddress, если нет email", () => {
    mockGetFileData.mockReturnValue(
      fileData({ recipients: [{ name: "Без email", smtpAddress: "smtp@test.local", recipType: "to" }] })
    );
    expect(parseMsg(Buffer.from("x")).to[0].address).toBe("smtp@test.local");
  });
});

describe("дата", () => {
  test("время отправки имеет приоритет", () => {
    mockGetFileData.mockReturnValue(
      fileData({
        clientSubmitTime: "2026-03-03T10:00:00.000Z",
        messageDeliveryTime: "2026-03-04T10:00:00.000Z",
        creationTime: "2026-03-05T10:00:00.000Z"
      })
    );
    expect(parseMsg(Buffer.from("x")).date).toBe("2026-03-03T10:00:00.000Z");
  });

  test("при отсутствии времени отправки берётся время доставки", () => {
    mockGetFileData.mockReturnValue(
      fileData({ clientSubmitTime: undefined, messageDeliveryTime: "2026-03-04T10:00:00.000Z" })
    );
    expect(parseMsg(Buffer.from("x")).date).toBe("2026-03-04T10:00:00.000Z");
  });

  test("нераспознанная дата не превращается в Invalid Date", () => {
    mockGetFileData.mockReturnValue(fileData({ clientSubmitTime: "не дата", messageDeliveryTime: undefined }));
    expect(parseMsg(Buffer.from("x")).date).toBeNull();
  });

  test("без дат поле пустое", () => {
    mockGetFileData.mockReturnValue(
      fileData({ clientSubmitTime: undefined, messageDeliveryTime: undefined, creationTime: undefined })
    );
    expect(parseMsg(Buffer.from("x")).date).toBeNull();
  });
});

describe("вложения", () => {
  test("имя, тип, размер и содержимое переносятся", () => {
    mockGetFileData.mockReturnValue(
      fileData({ attachments: [{ fileName: "акт.pdf", attachMimeTag: "application/pdf", pidContentId: "cid-1" }] })
    );
    mockGetAttachment.mockReturnValue({ fileName: "акт.pdf", content: new Uint8Array([1, 2, 3, 4]) });

    const att = parseMsg(Buffer.from("x")).attachments[0];
    expect(att.filename).toBe("акт.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.size).toBe(4);
    expect(att.content).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(att.contentId).toBe("cid-1");
  });

  test("без имени подставляется имя из библиотеки, затем заглушка", () => {
    mockGetFileData.mockReturnValue(fileData({ attachments: [{ fileName: undefined }] }));
    mockGetAttachment.mockReturnValue({ fileName: "из-библиотеки.bin", content: new Uint8Array([1]) });
    expect(parseMsg(Buffer.from("x")).attachments[0].filename).toBe("из-библиотеки.bin");

    mockGetAttachment.mockReturnValue({ fileName: "", content: new Uint8Array([1]) });
    expect(parseMsg(Buffer.from("x")).attachments[0].filename).toBe("attachment");
  });

  test("без типа MIME используется поток байтов", () => {
    mockGetFileData.mockReturnValue(fileData({ attachments: [{ fileName: "файл" }] }));
    expect(parseMsg(Buffer.from("x")).attachments[0].mimeType).toBe("application/octet-stream");
  });

  test("письмо без вложений даёт пустой список", () => {
    expect(parseMsg(Buffer.from("x")).attachments).toEqual([]);
  });
});

describe("незаполненные поля", () => {
  test("пустой разбор не роняет парсер", () => {
    mockGetFileData.mockReturnValue({});
    const p = parseMsg(Buffer.from("x"));
    expect(p.subject).toBe("(без темы)");
    expect(p.bodyText).toBe("");
    expect(p.to).toEqual([]);
    expect(p.from).toBeNull();
  });
});
