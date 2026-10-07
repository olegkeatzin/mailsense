/**
 * Граница подписи: атрибуция подписанта и подмена (task-13, security-specialist).
 *
 * Заказчик уточнил пайплайн: резолюцию пишет генеральный директор ответным письмом,
 * но вместо него подписать может ЛЮБОЙ, кому в админке выдали роль с правом
 * `resolution.approve`. Значит проверяемая граница:
 *   1) подпись персональна и отзываема — право, а не должность «ген.дир»;
 *   2) `approved_by` фиксирует ФАКТИЧЕСКОГО подписанта (и при подмене — его же);
 *   3) письмо от отправителя без права подписи не становится утверждением;
 *   4) подделка From/References не обходит проверку права ОТПРАВИТЕЛЯ;
 *   5) аппарат не утверждает вместо подписанта, подписант не отправляет вместо аппарата.
 *
 * ⚠️ Пакет server подменяет @mailsense/docflow и @mailsense/core: маршруты и middleware прав
 * работают по-настоящему, слой данных — мок. Проверяется ответственность МАРШРУТА: кого он
 * записывает подписантом и какие права требует. Атрибуция в БД (approved_by в строке и в
 * аудите) — зона тестов docflow, здесь проверяется, что маршрут передал именно фактического
 * подписанта. Прогон БД не требует.
 */
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());

jest.mock("@mailsense/docflow", () => {
  const m = require("./testing/mocks.js").docflowMockModule() as Record<string, unknown>;
  const resolution = () => ({ id: "res-1", status: "pending_approval", approvedBy: null });
  m.markEmailApproval = jest.fn(async () => ({ ...resolution(), status: "email_approval" }));
  m.confirmEmailApproval = jest.fn(async () => ({ ...resolution(), status: "approved" }));
  m.approveResolution = jest.fn(async () => ({ ...resolution(), status: "approved" }));
  // След аудита отказов: у проекта есть прецедент (journal.register_denied) — проверяем,
  // оставляет ли отказ в подписи след. Если функции нет в моке, тест это заметит.
  m.writeAudit = jest.fn(async () => null);
  return m;
});

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, TestUser>;
};
const mockedCore = core as unknown as Record<string, jest.Mock>;

const ROLES = ["admin", "secretary", "manager", "signer", "executor"] as const;
const token = (who: string) => "sign:" + who;

/** Сотрудник, которому выдали право подписи (не «ген.дир» по должности). */
const SIGNER = { id: "u-deputy", fullName: "Заместитель Директора" };
/** Второй обладатель права — на нём проверяется подмена подписанта. */
const SIGNER_2 = { id: "u-acting", fullName: "Исполняющий Обязанности" };

let app: RunningApp;

beforeAll(async () => {
  for (const role of [...ROLES, "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  // Обладатели права подписи: роль signer выдана персонально.
  mockedDocflow.__sessions.set(token("deputy"), testUser(SIGNER.id, ["signer"], { fullName: SIGNER.fullName }));
  mockedDocflow.__sessions.set(token("acting"), testUser(SIGNER_2.id, ["signer"], { fullName: SIGNER_2.fullName }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  // По умолчанию письмо пришло от обладателя права подписи.
  mockedCore.getEmailView.mockReturnValue({ id: "e-1", from: { address: "deputy@stand.test", name: SIGNER.fullName }, bodyText: "Согласовано" });
  mockedDocflow.getUserByEmail.mockImplementation(async (email: string) =>
    email === "deputy@stand.test" ? { ...SIGNER, email } : email === "acting@stand.test" ? { ...SIGNER_2, email } : null
  );
  mockedDocflow.getUser.mockImplementation(async (id: string) => ({ id, fullName: "Сотрудник " + id, email: id + "@stand.test" }));
  mockedDocflow.getUserRoles.mockImplementation(async (id: string) =>
    id === SIGNER.id || id === SIGNER_2.id ? ["signer"] : ["executor"]
  );
  mockedDocflow.getResolution.mockResolvedValue({ id: "res-1", status: "pending_approval", approvedBy: null });
});

describe("подпись · право resolution.approve в трёх путях (§6, Р8/Р9)", () => {
  const routes = [
    { path: "approve", what: "POST /resolutions/:id/approve — утверждение в приложении", allowed: ["admin", "manager", "signer"] },
    { path: "confirm", what: "POST /resolutions/:id/confirm — подтверждение разбора, шаг 2", allowed: ["admin", "secretary"] },
    { path: "mark-approval", what: "POST /resolutions/:id/mark-approval — аппарат отметил ответ", allowed: ["admin", "secretary"] }
  ];

  for (const route of routes) {
    it(route.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/" + route.path, {
          token: token(role),
          body: { emailId: "e-1", approvedBy: SIGNER.id }
        });
        const expected = route.allowed.includes(role) ? 200 : 403;
        if (res.status !== expected) failures.push(role + ": ждали " + expected + ", получили " + res.status + " — " + res.text.slice(0, 100));
      }
      const anon = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/" + route.path, { body: { emailId: "e-1" } });
      if (anon.status !== 401) failures.push("без токена: ждали 401, получили " + anon.status);
      expect(failures).toEqual([]);
    });
  }

  it("аппарат не утверждает вместо подписанта: у secretary нет resolution.approve", async () => {
    for (const path of ["approve"]) {
      const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/" + path, {
        token: token("secretary"),
        body: {}
      });
      expect(res.status).toBe(403);
    }
    expect(mockedDocflow.approveResolution).not.toHaveBeenCalled();
  });

  it("подписант не действует вместо аппарата: у signer нет resolution.dispatch", async () => {
    const dispatch = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("signer"),
      body: {}
    });
    expect(dispatch.status).toBe(403);
  });
});

describe("подпись · approved_by = фактический подписант (в т.ч. подмена)", () => {
  it("в приложении подписантом записывается тот, кто нажал: актёр сессии", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/approve", {
      token: token("deputy"),
      body: { text: "Исполнить" }
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.approveResolution).toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ id: SIGNER.id, name: SIGNER.fullName }),
      expect.anything()
    );
  });

  it("ПОДМЕНА: второй обладатель права подписывает — в карточку уходит он, а не первый", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/approve", {
      token: token("acting"),
      body: { text: "Исполнять" }
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.approveResolution).toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ id: SIGNER_2.id, name: SIGNER_2.fullName }),
      expect.anything()
    );
    // Ни «ген.дир» по умолчанию, ни первый подписант в записи не появляются.
    expect(mockedDocflow.approveResolution).not.toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ id: SIGNER.id }),
      expect.anything()
    );
  });

  it("ответом письмом: подписантом записывается ОТПРАВИТЕЛЬ письма, подтверждение — аппаратом", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-1", text: "Исполнить" }
    });
    expect(res.status).toBe(200);
    // Шаг 1 пишет подписанта (отправителя), а не аппарат.
    expect(mockedDocflow.markEmailApproval).toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ emailId: "e-1" }),
      expect.objectContaining({ id: SIGNER.id })
    );
    // Шаг 2 фиксирует approved_by = отправитель, а confirmed_by = аппарат (актёр сессии).
    const confirmCall = mockedDocflow.confirmEmailApproval.mock.calls[0];
    expect(confirmCall[0]).toBe("res-1");
    expect(confirmCall[1]).toMatchObject({ id: "u-secretary" });
    expect(confirmCall[2]).toMatchObject({ approvedBy: SIGNER.id });
  });

  it("ПОДМЕНА письмом: подписал другой обладатель права — он и записан", async () => {
    mockedCore.getEmailView.mockReturnValue({ id: "e-2", from: { address: "acting@stand.test", name: SIGNER_2.fullName }, bodyText: "Согласовано" });
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-2" }
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.markEmailApproval).toHaveBeenCalledWith(
      "res-1",
      expect.anything(),
      expect.objectContaining({ id: SIGNER_2.id })
    );
    expect(mockedDocflow.confirmEmailApproval.mock.calls[0][2]).toMatchObject({ approvedBy: SIGNER_2.id });
  });
});

describe("подпись · письмо без права подписи и подделка From/References", () => {
  it("отправитель без права подписи → 403 и НИ ОДНОГО изменения резолюции", async () => {
    mockedCore.getEmailView.mockReturnValue({ id: "e-3", from: { address: "petrova@stand.test", name: "Петрова М.А." }, bodyText: "Утверждаю" });
    mockedDocflow.getUserByEmail.mockResolvedValue({ id: "u-executor", fullName: "Петрова М.А.", email: "petrova@stand.test" });
    mockedDocflow.getUserRoles.mockResolvedValue(["executor"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-3" }
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain("права подписи");
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
    expect(mockedDocflow.approveResolution).not.toHaveBeenCalled();
    // D-3: попытка подписи без права оставляет след (кто пытался и кого назвал).
    expect(mockedDocflow.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resolution.approve_denied", entityId: "res-1" })
    );
  });

  it("подделка References: письмо в треде резолюции, но отправитель без права → 403", async () => {
    // Письмо ссылается на исходное (References/In-Reply-To) — сопоставление не даёт права.
    mockedCore.getEmailView.mockReturnValue({
      id: "e-forged",
      from: { address: "attacker@external.test", name: "Генеральный Директор" },
      bodyText: "Утверждаю",
      inReplyTo: "<res-1@stand.test>",
      references: ["<res-1@stand.test>"]
    });
    mockedDocflow.getUserByEmail.mockResolvedValue({ id: "u-unknown", fullName: "Кто-то", email: "attacker@external.test" });
    mockedDocflow.getUserRoles.mockResolvedValue([]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-forged" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });

  it("отправителя нет в базе → 400, «самозванец» не становится подписантом", async () => {
    mockedCore.getEmailView.mockReturnValue({ id: "e-4", from: { address: "nobody@external.test" }, bodyText: "Утверждаю" });
    mockedDocflow.getUserByEmail.mockResolvedValue(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-4" }
    });
    expect(res.status).toBe(400);
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
  });

  it("подписантом нельзя НАЗНАЧИТЬ человека без права: /confirm с чужим approvedBy → 403", async () => {
    mockedDocflow.getUser.mockResolvedValue({ id: "u-executor", fullName: "Петрова М.А." });
    mockedDocflow.getUserRoles.mockResolvedValue(["executor"]);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-executor" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });
});

describe("подпись · краевые случаи путей", () => {
  it("несуществующий approvedBy → 400, а не «назначили кого попало»", async () => {
    mockedDocflow.getUser.mockResolvedValue(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-нет-такого" }
    });
    expect(res.status).toBe(400);
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });

  it("менеджер с правом approve подписывает как менеджер, а не как «ген.дир» по должности", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/approve", {
      token: token("manager"),
      body: {}
    });
    expect(res.status).toBe(200);
    expect(mockedDocflow.approveResolution).toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ id: "u-manager" }),
      expect.anything()
    );
  });

  it("/mark-approval с несуществующим письмом → 400, подписант не выдумывается", async () => {
    mockedCore.getEmailView.mockReturnValue(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-нет" }
    });
    expect(res.status).toBe(400);
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });

  it("чужое письмо нельзя подписать: проверяется право АВТОРА письма, а не актёра", async () => {
    // Аппарат — обладатель dispatch, но не approve. Проверялось бы право актёра — попытка прошла бы;
    // проверяется право отправителя, поэтому письмо от человека без права подписи не подписать.
    mockedCore.getEmailView.mockReturnValue({ id: "e-6", from: { address: "secretary@stand.test" }, bodyText: "ок" });
    mockedDocflow.getUserByEmail.mockResolvedValue({ id: "u-secretary", fullName: "Секретарь", email: "secretary@stand.test" });
    mockedDocflow.getUserRoles.mockResolvedValue(["secretary"]);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-6" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
  });
});

describe("подпись · админка: право выдаётся и отзывается персонально", () => {
  it("PUT /users/:id/roles доступен только администратору и передаёт полный набор ролей", async () => {
    mockedDocflow.assignRoles.mockResolvedValue({ id: "u-executor", roles: ["signer"] });
    const asSecretary = await request(app.baseUrl, "PUT", "/api/users/u-executor/roles", {
      token: token("secretary"),
      body: { roleIds: ["signer"] }
    });
    expect(asSecretary.status).toBe(403);

    const asAdmin = await request(app.baseUrl, "PUT", "/api/users/u-executor/roles", {
      token: token("admin"),
      body: { roleIds: ["signer"] }
    });
    expect(asAdmin.status).toBe(200);
    // Полный набор, а не «добавить»: снятие роли так же возможно, как выдача.
    expect(mockedDocflow.assignRoles).toHaveBeenCalledWith("u-executor", ["signer"], expect.objectContaining({ id: "u-admin" }));
  });
});

// D-2/D-3 были ИЗВЕСТНЫМИ ДЕФЕКТАМИ (it.failing). Владелец закрыл их в T14:
// маршрут-вектор POST /:id/email-approval удалён, отказ в подписи пишет след
// resolution.approve_denied. Тесты переведены в обычные — это и есть доказательство починки.
// Красный прогон до починки зафиксирован в docs/security/stage5-review.md §8.3.
describe("подпись · D-2/D-3 закрыты: вектор удалён, отказ оставляет след", () => {
  it("D-2: маршрут-вектор POST /:id/email-approval больше не существует (404)", async () => {
    // Он стоял под правом аппарата и записывал подписантом самого аппарата — чистый
    // обход «подписант = обладатель resolution.approve». Веб его не использовал.
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/email-approval", {
      token: token("secretary"),
      body: { emailId: "e-anything" }
    });
    expect(res.status).toBe(404);
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
  });

  it("D-2: единственный путь письмом пишет подписантом ПРОВЕРЕННОГО отправителя, не аппарат", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-1" }
    });
    expect(res.status).toBe(200);
    const actor = mockedDocflow.markEmailApproval.mock.calls[0]?.[2] as { id?: string };
    expect(actor?.id).toBe(SIGNER.id);
    // Аппарат подписантом не становится ни на одном шаге.
    expect(actor?.id).not.toBe("u-secretary");
    expect(mockedDocflow.confirmEmailApproval.mock.calls[0]?.[2]).toMatchObject({ approvedBy: SIGNER.id });
  });

  it("D-3: отказ в подписи письмом оставляет след resolution.approve_denied с кандидатом", async () => {
    mockedCore.getEmailView.mockReturnValue({ id: "e-5", from: { address: "petrova@stand.test" }, bodyText: "Утверждаю" });
    mockedDocflow.getUserByEmail.mockResolvedValue({ id: "u-executor", fullName: "Петрова М.А." });
    mockedDocflow.getUserRoles.mockResolvedValue(["executor"]);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-5" }
    });
    expect(res.status).toBe(403);
    // След пишется ВНЕ транзакции изменения — прецедент journal.register_denied.
    expect(mockedDocflow.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resolution.approve_denied",
        entityType: "resolution",
        entityId: "res-1"
      })
    );
    const call = mockedDocflow.writeAudit.mock.calls[0][0] as { newValue?: string; userName?: string };
    expect(call.newValue).toContain("no_sign_right");
    expect(call.newValue).toContain("u-executor");
  });

  it("D-3: отказ при назначении подписанта без права тоже оставляет след", async () => {
    mockedDocflow.getUser.mockResolvedValue({ id: "u-executor", fullName: "Петрова М.А." });
    mockedDocflow.getUserRoles.mockResolvedValue(["executor"]);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-executor" }
    });
    expect(res.status).toBe(403);
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
    expect(mockedDocflow.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resolution.approve_denied", entityId: "res-1" })
    );
  });

  it("подписант без права в базе (нет такого пользователя) → 400 и след с причиной no_signer", async () => {
    mockedDocflow.getUser.mockResolvedValue(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-нет-такого" }
    });
    expect(res.status).toBe(400);
    const call = mockedDocflow.writeAudit.mock.calls[0][0] as { newValue?: string };
    expect(call.newValue).toContain("no_signer");
  });
});
