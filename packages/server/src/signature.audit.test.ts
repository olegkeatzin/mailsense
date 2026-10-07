import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * D-2 и D-3 от security-specialist (task-14).
 *
 * D-2: POST /:id/email-approval стоял под правом аппарата (resolution.dispatch) и записывал
 * подписантом САМОГО аппарата — штатным маршрутом обходилось правило «подписант — только
 * обладатель resolution.approve». Что за письмо пришло, определяет аппарат, но подписывает
 * подписант: маршрут, который делал это молча, — вектор обхода, а не рабочий путь.
 *
 * D-3: отказ в подписи (403) не оставлял следа. Прецедент — journal.register_denied:
 * неудачная попытка пишется отдельно и не откатывает ничего.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, unknown>;
};

const token = (role: string) => "token:" + role;

let expressApp: express.Express;
let app: RunningApp;

beforeAll(async () => {
  for (const role of ["admin", "secretary", "manager", "signer", "executor", "none"]) {
    mockedDocflow.__sessions.set(token(role), testUser("u-" + role, role === "none" ? [] : [role]));
  }
  expressApp = await createApp({});
  app = await listen(expressApp);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedDocflow.getResolution.mockResolvedValue({ id: "res-1", status: "pending_approval", approvedBy: null });
  mockedDocflow.getResolutionDetail.mockResolvedValue({
    id: "res-1",
    documentId: "doc-1",
    documentNumber: "вх1",
    text: "Подготовить ответ",
    deadline: null,
    status: "pending_approval",
    preparedBy: null,
    approvedBy: null,
    confirmedBy: null,
    dispatchedBy: null,
    assignees: []
  });
  mockedCore.getEmailView.mockReturnValue({
    id: "e-1",
    from: { address: "executor@stand.test", name: "Исполнитель" },
    bodyText: "Исполнить в срок"
  });
  mockedDocflow.getUserByEmail.mockResolvedValue({
    id: "u-executor",
    fullName: "Исполнитель",
    email: "executor@stand.test"
  });
});

describe("D-2: аппарат не подписывает вместо подписанта", () => {
  test("легаси-маршрут email-approval удалён — его больше нет", async () => {
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/email-approval", {
      token: token("secretary"),
      body: { emailId: "e-1" }
    });

    // Маршрута нет вовсе: удаление — часть защиты, а не косметика.
    expect(res.status).toBe(404);
    expect(mockedDocflow.markEmailApproval).not.toHaveBeenCalled();
  });

  test("аппарат не может назвать подписантом себя (confirm) — 403, состояние не меняется", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-secretary",
      fullName: "Аппарат",
      email: "secretary@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["secretary"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-secretary" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "no_sign_right" });
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });

  test("отправитель письма без права подписи не становится подписантом (mark-approval)", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-executor",
      fullName: "Исполнитель",
      email: "executor@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["executor"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-1" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "no_sign_right" });
    expect(mockedDocflow.confirmEmailApproval).not.toHaveBeenCalled();
  });
});

describe("D-3: отказ в подписи оставляет след", () => {
  test("в аудите видно, кто пытался подписать и кого назвал подписантом", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-secretary",
      fullName: "Аппарат",
      email: "secretary@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["secretary"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-secretary" }
    });
    expect(res.status).toBe(403);

    expect(mockedDocflow.writeAudit).toHaveBeenCalledTimes(1);
    const entry = mockedDocflow.writeAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: "resolution.approve_denied",
      entityType: "resolution",
      entityId: "res-1",
      userId: "u-secretary",
      userName: "Пользователь u-secretary"
    });
    // В следе — и кандидат, и причина: иначе спор «кто пытался подписать» не разрешить.
    expect(String(entry.newValue)).toContain("u-secretary");
    expect(String(entry.newValue)).toContain("no_sign_right");
  });

  test("отказ по письму без права подписи тоже пишет след, с адресом отправителя", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-executor",
      fullName: "Исполнитель",
      email: "executor@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["executor"]);

    await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/mark-approval", {
      token: token("secretary"),
      body: { emailId: "e-1" }
    });

    const entry = mockedDocflow.writeAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: "resolution.approve_denied", entityId: "res-1" });
    expect(String(entry.newValue)).toContain("executor@stand.test");
  });

  test("подписант с правом подписи проходит — отказа в следе нет", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-signer",
      fullName: "Подписант",
      email: "signer@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["signer"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-signer" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.writeAudit).not.toHaveBeenCalled();
  });

  test("сбой записи следа не подменяет отказ: наружу по-прежнему 403", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-executor",
      fullName: "Исполнитель",
      email: "executor@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["executor"]);
    mockedDocflow.writeAudit.mockRejectedValueOnce(new Error("БД недоступна"));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-executor" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "no_sign_right" });
  });
});
