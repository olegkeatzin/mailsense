import type express from "express";
import { createApp } from "./app.js";
import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser, type TestUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Матрица «маршрут × роль → код ответа».
 *
 * Проверяем её по-настоящему: приложение собирается целиком (createApp), запросы идут
 * HTTP-ом, а права ролей берутся из docflow — если снять requirePermission с маршрута,
 * соответствующая строка матрицы покраснеет.
 */

const ROLES = ["admin", "secretary", "manager", "signer", "executor"] as const;

const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & {
  __sessions: Map<string, TestUser>;
};
const mockedCore = core as unknown as Record<string, jest.Mock>;

const token = (role: string) => "token:" + role;

interface RouteCase {
  /** Что именно защищаем — формулировка требования. */
  what: string;
  method: string;
  path: string;
  body?: unknown;
  /** Роли, которым действие разрешено; остальным — 403. */
  allowed: string[];
  /** Код успешного ответа. */
  ok?: number;
}

const CASES: RouteCase[] = [
  {
    what: "PUT /api/users/:id/roles — роли выдаёт только администратор (рядовой не выдаст роль себе)",
    method: "PUT",
    path: "/api/users/u-executor/roles",
    body: { roleIds: ["admin"] },
    allowed: ["admin"]
  },
  {
    what: "PATCH /api/docflow/journal/:id — руководитель НЕ правит журнал",
    method: "PATCH",
    path: "/api/docflow/journal/doc-1",
    body: { summary: "правка" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/report — подписант НЕ отчитывается",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/report",
    body: { text: "исполнено" },
    allowed: ["admin", "secretary", "executor"]
  },
  {
    what: "PUT /api/settings — настройки предприятия меняет только администратор",
    method: "PUT",
    path: "/api/settings",
    body: { "ai.model": "qwen" },
    allowed: ["admin"]
  },
  {
    what: "PUT /api/ai/config — ключ модели не отдаётся рядовому",
    method: "PUT",
    path: "/api/ai/config",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "GET /api/users — список учётных записей только у администратора",
    method: "GET",
    path: "/api/users",
    allowed: ["admin"]
  },
  {
    what: "POST /api/users — заводить учётки только администратор",
    method: "POST",
    path: "/api/users",
    body: { email: "new@stand.test", fullName: "Новый" },
    allowed: ["admin"],
    ok: 201
  },
  {
    what: "POST /api/users/sync — синхронизация каталога только администратор",
    method: "POST",
    path: "/api/users/sync",
    allowed: ["admin"]
  },
  {
    what: "POST /api/docflow/journal — регистрация документа (руководитель не регистрирует)",
    method: "POST",
    path: "/api/docflow/journal",
    body: { summary: "письмо" },
    allowed: ["admin", "secretary"],
    ok: 201
  },
  {
    what: "GET /api/roles — справочник ролей виден всем, кто видит журнал",
    method: "GET",
    path: "/api/roles",
    allowed: [...ROLES]
  },
  {
    what: "POST /api/docflow/resolutions — черновик готовит аппарат и руководитель (подписант не готовит)",
    method: "POST",
    path: "/api/docflow/resolutions",
    body: { documentId: "doc-1", text: "Подготовить ответ" },
    // Право resolution.create есть у администратора, аппарата и руководителя (Р8):
    // он вправе написать текст и назначить исполнителя. У подписанта его нет.
    allowed: ["admin", "secretary", "manager"],
    ok: 201
  },
  {
    what: "POST /api/docflow/resolutions/:id/approve — утверждают подписант и руководитель, аппарат НЕ утверждает",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/approve",
    body: {},
    allowed: ["admin", "manager", "signer"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/confirm — подтверждает разбор письма только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/confirm",
    body: {},
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/dispatch — исполнителям отправляет только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/dispatch",
    body: {},
    allowed: ["admin", "secretary"]
  },
  {
    what: "POST /api/docflow/resolutions/:id/report/confirm — принять отчёт может только аппарат",
    method: "POST",
    path: "/api/docflow/resolutions/res-1/report/confirm",
    body: { userId: "u-executor" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "PUT /api/docflow/numbering — правила нумерации только с правом настроек",
    method: "PUT",
    path: "/api/docflow/numbering",
    body: { prefix: "вх" },
    allowed: ["admin"]
  },
  {
    what: "POST /api/docflow/numbering/archive — закрытие года только с правом архивации",
    method: "POST",
    path: "/api/docflow/numbering/archive",
    body: { period: "2026" },
    allowed: ["admin", "secretary"]
  },
  {
    what: "GET /api/audit — следы аудита только с правом аудита",
    method: "GET",
    path: "/api/audit",
    allowed: ["admin"]
  },
  {
    what: "PUT /api/docflow/settings — включение СЭД только администратор",
    method: "PUT",
    path: "/api/docflow/settings",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "PUT /api/directory/settings — каталог предприятия настраивает администратор",
    method: "PUT",
    path: "/api/directory/settings",
    body: {},
    allowed: ["admin"]
  },
  {
    what: "POST /api/directory/refresh — обновление каталога только администратор",
    method: "POST",
    path: "/api/directory/refresh",
    allowed: ["admin"]
  },
  {
    // ⚠️ Решение заказчика 2026-10-05: список ВСЕХ резолюций и канбан закрыты от исполнителя.
    // Он видит только свои задачи («Мои задачи»), чужие сроки, тексты и соисполнители ему
    // ни к чему. Права `journal.view` здесь мало — оно есть у всех ролей. Сквозная проверка
    // живёт в scripts/test_resolutions.mjs («рядовой сотрудник не видит список резолюций»).
    what: "GET /api/docflow/resolutions/board — канбан только тем, кто управляет поручениями",
    method: "GET",
    path: "/api/docflow/resolutions/board",
    allowed: ["admin", "secretary", "manager"]
  }
];

let expressApp: express.Express;
let app: RunningApp;

beforeAll(async () => {
  for (const role of [...ROLES, "none"]) {
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
});

describe("матрица «маршрут × роль»", () => {
  for (const route of CASES) {
    it(route.what, async () => {
      const failures: string[] = [];
      for (const role of ROLES) {
        const expected = route.allowed.includes(role) ? route.ok ?? 200 : 403;
        const res = await request(app.baseUrl, route.method, route.path, {
          token: token(role),
          body: route.body
        });
        if (res.status !== expected) {
          failures.push(
            role + ": ожидали " + expected + ", получили " + res.status + " — " + res.text.slice(0, 120)
          );
        }
      }
      const anonymous = await request(app.baseUrl, route.method, route.path, { body: route.body });
      if (anonymous.status !== 401) {
        failures.push("без сессии: ожидали 401, получили " + anonymous.status);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("отказ не доходит до изменения данных", () => {
  it("рядовой не может выдать роль себе — обработчик не вызывается", async () => {
    const assignRoles = mockedDocflow.assignRoles;
    const res = await request(app.baseUrl, "PUT", "/api/users/u-executor/roles", {
      token: token("executor"),
      body: { roleIds: ["admin"] }
    });
    expect(res.status).toBe(403);
    expect(assignRoles).not.toHaveBeenCalled();
  });

  it("руководитель не правит журнал — документ не меняется", async () => {
    const updateDocument = mockedDocflow.updateDocument;
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("manager"),
      body: { summary: "подмена" }
    });
    expect(res.status).toBe(403);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("подписант не отчитывается за исполнителя — отчёт не записывается", async () => {
    const reportExecution = mockedDocflow.reportExecution;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/report", {
      token: token("signer"),
      body: { text: "исполнено" }
    });
    expect(res.status).toBe(403);
    expect(reportExecution).not.toHaveBeenCalled();
  });

  it("в /confirm нельзя записать подписантом пользователя без права подписи", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-executor",
      fullName: "Исполнитель",
      email: "u-executor@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["executor"]);
    const confirmEmailApproval = mockedDocflow.confirmEmailApproval;

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-executor" }
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "no_sign_right" });
    expect(confirmEmailApproval).not.toHaveBeenCalled();
  });

  it("в /confirm подписант с правом подписи проходит", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce({
      id: "u-signer",
      fullName: "Подписант",
      email: "u-signer@stand.test"
    });
    mockedDocflow.getUserRoles.mockResolvedValueOnce(["signer"]);

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-signer" }
    });

    expect(res.status).toBe(200);
  });

  it("в /confirm нельзя назвать подписантом несуществующего пользователя", async () => {
    mockedDocflow.getUser.mockResolvedValueOnce(null);
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/confirm", {
      token: token("secretary"),
      body: { approvedBy: "u-призрак" }
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "no_signer" });
  });

  it("в /report/confirm нельзя подтвердить отчёт постороннему", async () => {
    const confirmReport = mockedDocflow.confirmReport;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/report/confirm", {
      token: token("secretary"),
      body: { userId: "u-outsider" }
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "not_assignee" });
    expect(confirmReport).not.toHaveBeenCalled();
  });

  it("подписант не отправляет поручение исполнителям", async () => {
    const dispatchResolution = mockedDocflow.dispatchResolution;
    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("signer"),
      body: {}
    });
    expect(res.status).toBe(403);
    expect(dispatchResolution).not.toHaveBeenCalled();
  });
});

describe("отправка поручения: захват → письмо → запись письма", () => {
  it("шаги идут по порядку: переход, письмо, запись идентификатора", async () => {
    const order: string[] = [];
    mockedDocflow.dispatchResolution.mockImplementationOnce(async () => {
      order.push("переход");
      return { id: "res-1", status: "sent" };
    });
    mockedCore.sendEmail.mockImplementationOnce(async () => {
      order.push("письмо");
      return { emailId: "sent-1", messageId: "<sent-1@stand.test>" };
    });
    mockedDocflow.attachDispatchEmail.mockImplementationOnce(async (id: string, emailId: string) => {
      order.push("запись письма");
      return { id, status: "sent", dispatchEmailId: emailId };
    });

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(200);
    expect(order).toEqual(["переход", "письмо", "запись письма"]);
    // Идентификатор письма вернулся клиенту — значит записан и в карточке поручения.
    expect(res.body).toMatchObject({ dispatchEmailId: "sent-1" });
  });

  it("проигравший гонку запрос не отправляет второе письмо", async () => {
    // docflow отдаёт 409 второму переходу (SELECT ... FOR UPDATE) — письма быть не должно.
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mockedDocflow.dispatchResolution
      .mockImplementationOnce(async () => ({ id: "res-1", status: "sent" }))
      .mockImplementationOnce(async () => {
        throw new AppError("Поручение уже отправлено", 409, "bad_state");
      });

    const [first, second] = await Promise.all([
      request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
        token: token("secretary"),
        body: {}
      }),
      request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
        token: token("secretary"),
        body: {}
      })
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(mockedCore.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("падение отправки: поручение возвращается в «утверждено», наружу — исходная ошибка", async () => {
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550: ящик отверг письмо"));

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("SMTP");
    // Откат выполнен: аппарат увидит поручение снова готовым к отправке.
    expect(mockedDocflow.revertDispatch).toHaveBeenCalledTimes(1);
    expect(String(mockedDocflow.revertDispatch.mock.calls[0][2])).toContain("Почтовый сервер не принял письмо");
    expect(mockedDocflow.attachDispatchEmail).not.toHaveBeenCalled();
  });

  it("отказ самого отката не подменяет исходную ошибку почты", async () => {
    const AppError = (docflow as unknown as { AppError: new (m: string, s: number, c: string) => Error }).AppError;
    mockedCore.sendEmail.mockRejectedValueOnce(new Error("SMTP 550"));
    mockedDocflow.revertDispatch.mockRejectedValueOnce(
      new AppError("Исполнитель уже отчитался", 409, "bad_state")
    );

    const res = await request(app.baseUrl, "POST", "/api/docflow/resolutions/res-1/dispatch", {
      token: token("secretary"),
      body: {}
    });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("SMTP");
    expect(res.text).not.toContain("отчитался");
  });
});

describe("сбой базы не выдаёт себя за выход из системы", () => {
  it("/api/auth/me отвечает 503, а не «user: null» (иначе клиент показывает вход)", async () => {
    mockedDocflow.resolveToken.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:55432"));

    const res = await request(app.baseUrl, "GET", "/api/auth/me", { token: token("admin") });

    expect(res.status).toBe(503);
    expect(String((res.body as { error?: string }).error)).toContain("База документооборота недоступна");
  });

  it("защищённый маршрут отвечает 503, а не 401", async () => {
    mockedDocflow.resolveToken.mockRejectedValueOnce(new Error("таймаут соединения"));

    const res = await request(app.baseUrl, "GET", "/api/users", { token: token("admin") });

    expect(res.status).toBe(503);
  });

  it("при живом входе /api/auth/me отдаёт пользователя как раньше", async () => {
    const res = await request(app.baseUrl, "GET", "/api/auth/me", { token: token("admin") });

    expect(res.status).toBe(200);
    expect((res.body as { user: { id: string } }).user.id).toBe("u-admin");
  });
});

describe("статус документа проверяется на сервере", () => {
  it("неизвестный статус отклонён с 400, документ не меняется", async () => {
    const updateDocument = mockedDocflow.updateDocument;

    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { status: "почти исполнен" }
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad_status" });
    expect(String((res.body as { error?: string }).error)).toContain("executed");
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("известный статус принимается и уходит в базу", async () => {
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { status: "executed" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.updateDocument.mock.calls[0][1]).toMatchObject({ status: "executed" });
  });

  it("без статуса прочие поля правятся как раньше", async () => {
    const res = await request(app.baseUrl, "PATCH", "/api/docflow/journal/doc-1", {
      token: token("secretary"),
      body: { summary: "уточнено" }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.updateDocument.mock.calls[0][1]).toMatchObject({ summary: "уточнено" });
  });
});

/** Префиксы, которые обслуживает сервер документооборота: всё здесь под правами. */
const DOCFLOW_PREFIXES = ["/api/docflow", "/api/users", "/api/roles", "/api/audit", "/api/directory"];

/**
 * Осознанное исключение: статус каталога нужен любому вошедшему — от него зависит,
 * показывать ли автодополнение адресов. Данных предприятия маршрут не раскрывает.
 */
const OPEN_TO_ANY_AUTHENTICATED = new Set(["GET /api/directory/status"]);

function routesOf(appInstance: express.Express): Array<{ method: string; path: string }> {
  const stack =
    (appInstance as unknown as { _router?: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })
      ._router?.stack ?? [];
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods ?? {})) {
      if (method === "_all") continue;
      routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

describe("ни один маршрут документооборота не остался без проверки", () => {
  it("пользователь без прав получает 403, без сессии — 401, на каждом маршруте", async () => {
    const routes = routesOf(expressApp).filter((route) =>
      DOCFLOW_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(prefix + "/"))
    );
    // Маршрутов много: если разбор стека сломается, тест обязан заметить это, а не «пройти».
    expect(routes.length).toBeGreaterThanOrEqual(30);

    const failures: string[] = [];
    for (const route of routes) {
      if (OPEN_TO_ANY_AUTHENTICATED.has(route.method + " " + route.path)) continue;
      const url = route.path.replace(/:([A-Za-z0-9_]+)/g, "test-$1");

      const rightless = await request(app.baseUrl, route.method, url, { token: token("none") });
      if (rightless.status !== 403) {
        failures.push(
          route.method + " " + route.path + ": пользователь без прав получил " + rightless.status
        );
      }

      const anonymous = await request(app.baseUrl, route.method, url);
      if (anonymous.status !== 401) {
        failures.push(route.method + " " + route.path + ": без сессии получили " + anonymous.status);
      }
    }
    expect(failures).toEqual([]);
  });

  it("исключение из проверки — только статус каталога", async () => {
    const routes = routesOf(expressApp)
      .filter((route) =>
        DOCFLOW_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(prefix + "/"))
      )
      .map((route) => route.method + " " + route.path)
      .filter((id) => !CASES.some((c) => c.method + " " + c.path === id))
      .filter((id) => !OPEN_TO_ANY_AUTHENTICATED.has(id));
    // Список непустой: значит маршруты действительно находятся, а не «пронесло».
    expect(routes.length).toBeGreaterThan(10);
  });
});
