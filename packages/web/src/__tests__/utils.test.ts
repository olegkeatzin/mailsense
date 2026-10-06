import { formatAssignees } from "../utils";

/**
 * В карточке документа список исполнителей собирался через join(", ") и при
 * пустых именах (учётки без ФИО в каталоге) превращался в «Исполнители: ,» —
 * человек видел мусор вместо ответа на вопрос «кто исполняет».
 */
describe("formatAssignees", () => {
  it("перечисляет имена через запятую", () => {
    expect(formatAssignees([{ fullName: "Мария Петрова", email: "p@test" }, { fullName: "Иван Иванов", email: "i@test" }]))
      .toBe("Мария Петрова, Иван Иванов");
  });

  it("пустой список — прочерк, а не пустая строка", () => {
    expect(formatAssignees([])).toBe("—");
  });

  it("пустые имена не превращаются в одинокие запятые", () => {
    const result = formatAssignees([
      { fullName: "  ", email: "petrova_ma@mail.test" },
      { fullName: "", email: "user2@mail.test" }
    ]);
    expect(result).not.toContain(", ,");
    expect(result).not.toMatch(/^\s*,/);
    expect(result).toBe("petrova_ma@mail.test, user2@mail.test");
  });

  it("когда нет ни имени, ни адреса — понятная подпись", () => {
    expect(formatAssignees([{ fullName: "", email: "" }])).toBe("исполнитель без имени");
  });
});
