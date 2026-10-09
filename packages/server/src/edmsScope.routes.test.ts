import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

import { EDMS_WORK_ACCOUNT_SETTING } from "@mailsense/docflow";
import { edmsAccountScope, unregisteredInbox } from "./journalRoutes.js";

/**
 * Очередь СЭД и предпросмотр правил показывают ТОЛЬКО почту СЭД: служебные ящики
 * (внутренний + внешняя приёмная) и личный рабочий ящик работника. Письма обычных
 * внешних ящиков (Яндекс и т.п.) в очереди аппарата появляться не должны.
 */
const mockedCore = core as unknown as Record<string, jest.Mock>;
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, unknown>;
};

const token = (role: string) => "token:" + role;
const emptyMatch = { matched: false, labels: [], notes: [], priority: null, ruleIds: [] };

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
  mockedCore.listEmailsWithAnalysis.mockReturnValue([]);
  mockedCore.countAttachmentsByEmail.mockReturnValue(new Map());
  mockedCore.matchSortRules.mockReturnValue(emptyMatch);
  mockedDocflow.listRegisteredEmailIds.mockResolvedValue([]);
  mockedDocflow.listSortRules.mockResolvedValue([]);
  mockedDocflow.getServiceAccountId.mockResolvedValue(null);
  mockedDocflow.getExternalAccountId.mockResolvedValue(null);
  mockedDocflow.getUserSetting.mockResolvedValue(null);
});

describe("состав почты СЭД", () => {
  test("служебные ящики плюс личный рабочий ящик работника, без дублей и пробелов", async () => {
    mockedDocflow.getServiceAccountId.mockResolvedValue(" internal ");
    mockedDocflow.getExternalAccountId.mockResolvedValue("external");
    // «Почта для СЭД» — настройка ЛИЧНАЯ: у аппарата свой ящик, у администратора свой выбор.
    mockedDocflow.getUserSetting.mockImplementation(async (userId: string, key: string) =>
      key === EDMS_WORK_ACCOUNT_SETTING && userId === "u-secretary" ? "internal" : null
    );

    expect(await edmsAccountScope("u-secretary")).toEqual(["internal", "external"]);
    expect(await edmsAccountScope("u-admin")).toEqual(["internal", "external"]);
  });

  test("чужой личный ящик в очередь не подставляется", async () => {
    mockedDocflow.getServiceAccountId.mockResolvedValue("acc-service");
    mockedDocflow.getUserSetting.mockResolvedValue("acc-work-чужая");

    // Без работника личную настройку вообще не читаем.
    expect(await edmsAccountScope(null)).toEqual(["acc-service"]);
    expect(mockedDocflow.getUserSetting).not.toHaveBeenCalled();
  });

  test("ничего не настроено — пустой состав: почты для СЭД нет вовсе", async () => {
    expect(await edmsAccountScope("u-secretary")).toEqual([]);
  });
});

describe("очередь и предпросмотр берут только разрешённую почту", () => {
  test("«Входящие на регистрацию» фильтруют по составу СЭД", async () => {
    mockedDocflow.getServiceAccountId.mockResolvedValue("acc-service");
    mockedDocflow.getExternalAccountId.mockResolvedValue("acc-external");
    mockedDocflow.getUserSetting.mockImplementation(async (userId: string, key: string) =>
      key === EDMS_WORK_ACCOUNT_SETTING && userId === "u-secretary" ? "acc-work" : null
    );

    await unregisteredInbox("INBOX", "u-secretary");

    expect(mockedCore.listEmailsWithAnalysis).toHaveBeenCalledWith({
      folder: "INBOX",
      accountIds: ["acc-service", "acc-external", "acc-work"]
    });
  });

  test("ничего не настроено — в ядро уходит ПУСТОЙ список, а не все ящики", async () => {
    await unregisteredInbox("INBOX", "u-secretary");
    expect(mockedCore.listEmailsWithAnalysis).toHaveBeenCalledWith({ folder: "INBOX", accountIds: [] });
  });

  test("оба потребителя идут через один помощник и берут личный ящик СВОЕГО работника", async () => {
    mockedDocflow.getServiceAccountId.mockResolvedValue("acc-service");
    mockedDocflow.getUserSetting.mockImplementation(async (userId: string, key: string) =>
      key === EDMS_WORK_ACCOUNT_SETTING && userId === "u-secretary" ? "acc-work-secretary" : null
    );

    const queue = await request(app.baseUrl, "GET", "/api/docflow/journal/incoming", { token: token("secretary") });
    expect(queue.status).toBe(200);

    const preview = await request(app.baseUrl, "POST", "/api/docflow/sorting/rules/preview", {
      token: token("admin"),
      body: { name: "От поставщика", matchFrom: "поставщик" }
    });
    expect(preview.status).toBe(200);

    // Один и тот же помощник у обеих ручек, но личный ящик — каждого работника свой.
    expect(mockedCore.listEmailsWithAnalysis).toHaveBeenCalledTimes(2);
    expect(mockedCore.listEmailsWithAnalysis.mock.calls[0][0]).toMatchObject({
      folder: "INBOX",
      accountIds: ["acc-service", "acc-work-secretary"]
    });
    expect(mockedCore.listEmailsWithAnalysis.mock.calls[1][0]).toMatchObject({
      folder: "INBOX",
      accountIds: ["acc-service"]
    });
  });
});
