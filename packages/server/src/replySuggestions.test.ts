import { executorsFromReply } from "./replyExecutors.js";

/**
 * Руководитель ответил из Outlook, а не из нашей системы: метки нет, тред может быть
 * потерян. Заказчик решил: исполнители — те, кого он поставил в получатели и копию,
 * кроме нашего служебного ящика и его самого.
 */
describe("исполнители из ответа руководителя", () => {
  it("берёт получателей и копию, исключая нас и самого руководителя", () => {
    const list = executorsFromReply({
      from: "Boss@Company.test",
      to: [{ address: "apparat@company.test", name: "Аппарат" }],
      cc: [
        { address: "ivanov@company.test", name: "Иванов" },
        { address: "petrov@company.test", name: "Петров" },
        { address: "boss@company.test", name: "Руководитель" }
      ],
      exclude: ["apparat@company.test"]
    });

    expect(list).toEqual([
      { address: "ivanov@company.test", name: "Иванов" },
      { address: "petrov@company.test", name: "Петров" }
    ]);
  });

  it("один и тот же адрес в разных регистрах считается один раз", () => {
    const list = executorsFromReply({
      from: "boss@company.test",
      to: [{ address: "Ivanov@company.test" }],
      cc: [{ address: "ivanov@company.test" }],
      exclude: []
    });
    expect(list).toHaveLength(1);
  });

  it("пустые адреса пропускаются, а не превращаются в пустого исполнителя", () => {
    const list = executorsFromReply({
      from: "",
      to: [{ address: "  " }],
      cc: [{ address: "petrov@company.test", name: "" }],
      exclude: [""]
    });
    expect(list).toEqual([{ address: "petrov@company.test", name: "" }]);
  });

  it("если руководитель написал только аппарату — исполнителей нет", () => {
    const list = executorsFromReply({
      from: "boss@company.test",
      to: [{ address: "apparat@company.test" }],
      cc: [],
      exclude: ["apparat@company.test"]
    });
    expect(list).toEqual([]);
  });
});
