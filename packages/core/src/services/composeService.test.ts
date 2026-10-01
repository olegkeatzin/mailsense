import {
  replySubject,
  forwardSubject,
  formatAttribution,
  formatDateHuman,
  quotePlainText,
  signatureText,
  signatureHtml,
  signatureOptions,
  buildReferences
} from "./composeService.js";

describe("тема ответа/пересылки", () => {
  test("не дублирует Re:/Fwd:", () => {
    expect(replySubject("Тема")).toBe("Re: Тема");
    expect(replySubject("Re: Тема")).toBe("Re: Тема");
    expect(replySubject("Re: Re: Тема")).toBe("Re: Тема");
    expect(forwardSubject("FW: Тема")).toBe("Fwd: Тема");
    expect(forwardSubject("Тема")).toBe("Fwd: Тема");
  });
});

describe("строка атрибуции", () => {
  test("русская и английская", () => {
    const ru = formatAttribution("2026-09-29T18:04:00Z", { name: "Иванов И.И.", address: "i@t" });
    expect(ru).toContain("Иванов И.И. пишет:");
    const en = formatAttribution("2026-09-29T18:04:00Z", { name: "Ivanov", address: "i@t" }, "en");
    expect(en).toMatch(/^On .*Ivanov wrote:$/);
  });

  test("без отправителя — заглушка, без даты — без даты", () => {
    expect(formatAttribution(null, null)).toBe("(неизвестный отправитель) пишет:");
    expect(formatDateHuman(null)).toBe("");
  });
});

describe("цитата", () => {
  test("каждая строка с префиксом >", () => {
    expect(quotePlainText("привет\nпока")).toBe("> привет\n> пока");
  });
});

describe("подпись", () => {
  test("разделитель -- и перевод строк", () => {
    expect(signatureText({ text: "С уважением,\nИванов" })).toBe("-- \nС уважением,\nИванов");
  });
  test("без разделителя и выключенная", () => {
    expect(signatureText({ text: "x", delimiter: false })).toBe("x");
    expect(signatureText({ text: "x", enabled: false })).toBe("");
    expect(signatureText({ text: "   " })).toBe("");
  });
  test("html-подпись экранирует текст", () => {
    const html = signatureHtml({ text: "<b>Олег</b>" });
    expect(html).toContain("&lt;b&gt;Олег&lt;/b&gt;");
    expect(html).toContain("mailsense-signature");
  });
  test("signatureOptions по умолчанию: включена, снизу, с разделителем", () => {
    const o = signatureOptions({});
    expect(o.enabled).toBe(true);
    expect(o.position).toBe("below");
    expect(o.delimiter).toBe(true);
    const o2 = signatureOptions({ signaturePosition: "above", signatureDelimiter: false, signatureEnabled: false });
    expect(o2.position).toBe("above");
    expect(o2.delimiter).toBe(false);
    expect(o2.enabled).toBe(false);
  });
});

describe("цепочка References", () => {
  test("старые -> новые + Message-ID родителя, без дублей и скобок", () => {
    expect(buildReferences({ messageId: "c@t", references: ["a@t", "b@t"] })).toEqual(["a@t", "b@t", "c@t"]);
    expect(buildReferences({ messageId: "<c@t>", references: ["<a@t>", "a@t"] })).toEqual(["a@t", "c@t"]);
    expect(buildReferences({ messageId: "c@t" })).toEqual(["c@t"]);
  });
});
