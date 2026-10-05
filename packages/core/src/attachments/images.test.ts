import { imageToDataUrl, SUPPORTED_IMAGE_MIME } from "./images.js";

/**
 * Тип картинки определяется по содержимому, а не по имени файла: вложения
 * приходят с самыми разными именами, а модель ждёт корректный data-URL.
 */
describe("определение типа изображения", () => {
  test("PNG по сигнатуре", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(imageToDataUrl(png)).toMatch(/^data:image\/png;base64,/);
  });

  test("JPEG по сигнатуре", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(imageToDataUrl(jpeg)).toMatch(/^data:image\/jpeg;base64,/);
  });

  test("GIF по сигнатуре", () => {
    const gif = Buffer.from("GIF89a....", "ascii");
    expect(imageToDataUrl(gif)).toMatch(/^data:image\/gif;base64,/);
  });

  test("WEBP распознаётся по RIFF-обёртке", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
      Buffer.from([0x00])
    ]);
    expect(imageToDataUrl(webp)).toMatch(/^data:image\/webp;base64,/);
  });

  test("неизвестный формат считается PNG, а не падает", () => {
    expect(imageToDataUrl(Buffer.from("неизвестно"))).toMatch(/^data:image\/png;base64,/);
  });

  test("пустой буфер не роняет определение типа", () => {
    expect(imageToDataUrl(Buffer.alloc(0))).toMatch(/^data:image\/png;base64,$/);
  });

  test("содержимое кодируется в base64 без искажений", () => {
    const data = Buffer.from("проверка");
    const url = imageToDataUrl(data);
    expect(Buffer.from(url.split(",")[1], "base64").toString("utf8")).toBe("проверка");
  });
});

describe("поддерживаемые типы", () => {
  test("распознаёт png, jpeg, gif, webp", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(SUPPORTED_IMAGE_MIME.test(m)).toBe(true);
    }
  });

  test("не пропускает прочие типы", () => {
    for (const m of ["application/pdf", "image/svg+xml", "image/bmp", "text/plain"]) {
      expect(SUPPORTED_IMAGE_MIME.test(m)).toBe(false);
    }
  });
});
