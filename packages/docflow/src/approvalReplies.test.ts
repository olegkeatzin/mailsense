import { matchReplies, parseEdmsMarker, type AwaitingApproval, type ReplyCandidate } from "./approvalReplies.js";

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
/**
 * Техническая метка СЭД в заголовках: заказчик просил ставить в письме то, по чему
 * система на другом конце узнаёт письмо. Метка сильнее треда — её не ломает пересылка.
 */
describe("распознавание по метке СЭД", () => {
  test("метка разбирается: документ, поручение, вид письма", () => {
    expect(parseEdmsMarker({ "x-mailsense-edms": "doc=doc-7; res=res-3; kind=dispatch; v=1" })).toEqual({
      documentId: "doc-7",
      resolutionId: "res-3",
      kind: "dispatch"
    });
  });

  test("регистр названия заголовка не важен, прочерк означает «нет поручения»", () => {
    expect(parseEdmsMarker({ "X-MailSense-EDMS": "doc=doc-7; res=-" })?.resolutionId).toBeNull();
  });

  test("чужая метка или письмо без неё не считаются нашими", () => {
    expect(parseEdmsMarker({ subject: "привет" })).toBeNull();
    expect(parseEdmsMarker(null)).toBeNull();
    // doc=- значит «не наш документ»: письмо не должно стать резолюцией.
    expect(parseEdmsMarker({ "x-mailsense-edms": "doc=-; res=res-3" })).toBeNull();
  });

  test("метка находит ответ, даже если тред потерян (пересылка)", () => {
    const m = matchReplies(WAITING, [
      { emailId: "e9", inReplyTo: null, references: [], headers: { "x-mailsense-edms": "doc=d1; res=res-2; kind=forward" } }
    ]);
    expect(m).toEqual([{ resolutionId: "res-2", emailId: "e9" }]);
  });

  test("метка на неизвестное поручение не срабатывает — работает тред", () => {
    const m = matchReplies(WAITING, [
      {
        emailId: "e10",
        inReplyTo: "<req-1@mail.test>",
        references: [],
        headers: { "x-mailsense-edms": "doc=d1; res=res-999; kind=forward" }
      }
    ]);
    expect(m).toEqual([{ resolutionId: "res-1", emailId: "e10" }]);
  });

  test("одна резолюция — один ответ, даже если пришли и метка, и тред", () => {
    const m = matchReplies(WAITING, [
      { emailId: "e11", inReplyTo: "<req-1@mail.test>", references: [], headers: { "x-mailsense-edms": "doc=d1; res=res-1" } }
    ]);
    expect(m).toEqual([{ resolutionId: "res-1", emailId: "e11" }]);
  });
});
