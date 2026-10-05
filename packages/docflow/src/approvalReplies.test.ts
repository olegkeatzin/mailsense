import { matchReplies, type AwaitingApproval, type ReplyCandidate } from "./approvalReplies.js";

/**
 * Сопоставление ответа руководителя с запросом резолюции.
 *
 * Место опасное: ошибка здесь либо оставит ответ незамеченным (аппарат не узнает,
 * что руководитель ответил), либо, наоборот, превратит в резолюцию постороннее письмо.
 * Поэтому проверяются и попадания, и промахи.
 */
const WAITING: AwaitingApproval[] = [
  { resolutionId: "res-1", requestMessageId: "<req-1@mail.test>" },
  { resolutionId: "res-2", requestMessageId: "req-2@mail.test" }
];

function reply(emailId: string, inReplyTo: string | null, references: string[] = []): ReplyCandidate {
  return { emailId, inReplyTo, references };
}

describe("сопоставление ответа с запросом", () => {
  test("ответ по In-Reply-To находится", () => {
    const m = matchReplies(WAITING, [reply("e1", "<req-1@mail.test>")]);
    expect(m).toEqual([{ resolutionId: "res-1", emailId: "e1" }]);
  });

  test("ответ только по References тоже находится", () => {
    // Часть клиентов не ставит In-Reply-To, ограничиваясь цепочкой.
    const m = matchReplies(WAITING, [reply("e1", null, ["<other@x>", "<req-2@mail.test>"])]);
    expect(m).toEqual([{ resolutionId: "res-2", emailId: "e1" }]);
  });

  test("угловые скобки и регистр не мешают", () => {
    const m = matchReplies(
      [{ resolutionId: "res-3", requestMessageId: "REQ-3@MAIL.TEST" }],
      [reply("e1", "<req-3@mail.test>")]
    );
    expect(m).toHaveLength(1);
  });

  test("письмо без признаков треда ответом не считается", () => {
    // Иначе резолюцией стало бы любое письмо от руководителя в ящике.
    expect(matchReplies(WAITING, [reply("e1", null, [])])).toEqual([]);
  });

  test("ответ не в тот тред не подходит", () => {
    expect(matchReplies(WAITING, [reply("e1", "<совсем-другое@mail.test>")])).toEqual([]);
  });

  test("по одному запросу принимается только первый ответ", () => {
    // Руководитель мог ответить дважды; второй ответ не должен переписывать первый.
    const m = matchReplies(WAITING, [reply("e1", "<req-1@mail.test>"), reply("e2", "<req-1@mail.test>")]);
    expect(m).toEqual([{ resolutionId: "res-1", emailId: "e1" }]);
  });

  test("два разных запроса — два ответа", () => {
    const m = matchReplies(WAITING, [reply("e1", "<req-1@mail.test>"), reply("e2", "<req-2@mail.test>")]);
    expect(m).toHaveLength(2);
  });

  test("без ожидающих резолюций ничего не находится", () => {
    expect(matchReplies([], [reply("e1", "<req-1@mail.test>")])).toEqual([]);
  });

  test("резолюция без Message-ID запроса не участвует", () => {
    // Пересылка могла не сохранить письмо — тогда сопоставлять не с чем.
    const m = matchReplies([{ resolutionId: "res-x", requestMessageId: null }], [reply("e1", "<req-1@mail.test>")]);
    expect(m).toEqual([]);
  });

  test("пустой список писем ничего не ломает", () => {
    expect(matchReplies(WAITING, [])).toEqual([]);
  });
});