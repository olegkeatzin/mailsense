jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

import { isForwardedEmail } from "./journalRoutes.js";

describe("пересланное письмо", () => {
  it("обычное письмо не считается пересланным", () => {
    expect(isForwardedEmail({ subject: "Приглашение на ВКС", bodyText: "Добрый день" })).toBe(false);
  });

  it.each(["Fwd: Проект", "FW: Проект", "Пересл.: Проект", "Переслано: Проект"])(
    "тема %s — пересылка",
    (subject) => {
      expect(isForwardedEmail({ subject, bodyText: "" })).toBe(true);
    }
  );

  it("маркер пересылки в теле — пересылка", () => {
    expect(
      isForwardedEmail({ subject: "Проект", bodyText: "---------- Пересылаемое сообщение ----------" })
    ).toBe(true);
  });
});
