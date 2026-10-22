import * as core from "@mailsense/core";
import * as docflow from "@mailsense/docflow";
import { createApp } from "./app.js";
import { listen, request, type RunningApp } from "./testing/harness.js";
import { testUser } from "./testing/mocks.js";

jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Конструктор ролей на маршрутах: администратор заводит роли и расставляет права галочками.
 *
 * Проверяем право доступа (рядовому — 403), понятные отказы (400 с текстом ядра) и то,
 * что отказ ядра не превращается в «ошибку сервера».
 */
const mockedDocflow = docflow as unknown as Record<string, jest.Mock> & { __sessions: Map<string, unknown> };

const ADMIN = "token:admin";
const WORKER = "token:worker";
/** Управляющий пользователями, но без права на журнал: такую роль заводит конструктор. */
const ROLE_MANAGER = "token:role-manager";
/** Аудитор: ему роли нужны только чтобы показать названия в журнале аудита. */
const AUDITOR = "token:auditor";
/** Работник без прав документооборота: роли ему не нужны вовсе. */
const NO_RIGHTS = "token:no-rights";
let app: RunningApp;

beforeAll(async () => {
  mockedDocflow.__sessions.set(ADMIN, testUser("u-admin", ["admin"]));
  mockedDocflow.__sessions.set(WORKER, testUser("u-worker", ["executor"]));
  mockedDocflow.__sessions.set(ROLE_MANAGER, testUser("u-role-manager", [], { permissions: ["users.manage"] }));
  mockedDocflow.__sessions.set(AUDITOR, testUser("u-auditor", [], { permissions: ["audit.view"] }));
  mockedDocflow.__sessions.set(NO_RIGHTS, testUser("u-no-rights", [], { permissions: [] }));
  app = await listen(await createApp({}));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedDocflow.listRolesFromDb.mockResolvedValue([
    { id: "admin", name: "Администратор", description: "", permissions: ["users.manage"], isSystem: true, sortOrder: 10 }
  ]);
});

describe("право на конструктор ролей", () => {
  test("рядовому работнику закрыто: 403 и роль не создаётся", async () => {
    const res = await request(app.baseUrl, "POST", "/api/roles", { token: WORKER, body: { name: "Своя" } });

    expect(res.status).toBe(403);
    expect(mockedDocflow.createRole).not.toHaveBeenCalled();
  });

  test("без сессии — 401", async () => {
    expect((await request(app.baseUrl, "GET", "/api/roles/permission-catalog")).status).toBe(401);
  });
});

describe("чтение ролей и каталога прав", () => {
  test("роли отдаются с их правами", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles", { token: ADMIN });

    expect(res.status).toBe(200);
    expect(mockedDocflow.listRolesFromDb).toHaveBeenCalled();
  });

  test("каталог прав — списком для галочек", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles/permission-catalog", { token: ADMIN });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Каталог настоящий: в нём есть группы и человеческие названия (мок берёт его из docflow).
    expect(JSON.stringify(res.body)).toContain("journal.view");
  });

  /**
   * Роль без права на журнал — законная настройка: заказчик уже снял journal.view
   * у исполнителя. Список ролей при этом обязан открываться по users.manage, иначе
   * администратор с такой ролью не увидит ни ролей, ни пользователей (UsersTab грузит их
   * одним Promise.all). Раньше маршрут требовал именно journal.view.
   */
  test("управляющему пользователями список ролей доступен без права на журнал", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles", { token: ROLE_MANAGER });

    expect(res.status).toBe(200);
    expect(mockedDocflow.listRolesFromDb).toHaveBeenCalled();
  });

  test("аудитору список ролей доступен: по нему «Аудит» показывает названия ролей", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles", { token: AUDITOR });

    expect(res.status).toBe(200);
  });

  test("работнику без прав документооборота список ролей закрыт", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles", { token: NO_RIGHTS });

    expect(res.status).toBe(403);
  });

  test("исполнителю с журналом список ролей доступен, как и раньше", async () => {
    const res = await request(app.baseUrl, "GET", "/api/roles", { token: WORKER });

    expect(res.status).toBe(200);
  });
});

describe("создание и правка роли", () => {
  test("создание передаёт название и права, отвечает 201", async () => {
    const res = await request(app.baseUrl, "POST", "/api/roles", {
      token: ADMIN,
      body: { name: "Делопроизводитель", permissions: ["journal.view", "journal.register"] }
    });

    expect(res.status).toBe(201);
    expect(mockedDocflow.createRole).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Делопроизводитель" }),
      expect.objectContaining({ id: "u-admin" })
    );
  });

  test("отказ ядра — 400 с его текстом, а не 500", async () => {
    mockedDocflow.createRole.mockRejectedValue(
      new (docflow as unknown as { RoleInputError: new (m: string, c?: string) => Error }).RoleInputError(
        "Неизвестное право: нет-такого",
        "role.unknown_permission"
      )
    );

    const res = await request(app.baseUrl, "POST", "/api/roles", {
      token: ADMIN,
      body: { name: "Кривая", permissions: ["нет-такого"] }
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("Неизвестное право");
  });

  test("правка роли меняет права", async () => {
    const res = await request(app.baseUrl, "PUT", "/api/roles/executor", {
      token: ADMIN,
      body: { permissions: ["task.view"] }
    });

    expect(res.status).toBe(200);
    expect(mockedDocflow.updateRole).toHaveBeenCalledWith("executor", expect.objectContaining({ permissions: ["task.view"] }), expect.anything());
  });

  test("«Администратора» изменить нельзя: ядро отказывает, маршрут отдаёт 400", async () => {
    mockedDocflow.updateRole.mockRejectedValue(
      new (docflow as unknown as { RoleInputError: new (m: string, c?: string) => Error }).RoleInputError(
        "Роль «Администратор» изменить нельзя: она всегда даёт все права",
        "role.admin_immutable"
      )
    );

    const res = await request(app.baseUrl, "PUT", "/api/roles/admin", { token: ADMIN, body: { permissions: [] } });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("Администратор");
  });

  test("удаление роли", async () => {
    const res = await request(app.baseUrl, "DELETE", "/api/roles/custom", { token: ADMIN });

    expect(res.status).toBe(200);
    expect(mockedDocflow.deleteRole).toHaveBeenCalledWith("custom", expect.anything());
  });

  test("назначенную роль удалить нельзя — 400 с объяснением", async () => {
    mockedDocflow.deleteRole.mockRejectedValue(
      new (docflow as unknown as { RoleInputError: new (m: string, c?: string) => Error }).RoleInputError(
        "Роль назначена работникам (2). Сначала снимите её в списке пользователей, потом удаляйте",
        "role.assigned"
      )
    );

    const res = await request(app.baseUrl, "DELETE", "/api/roles/custom", { token: ADMIN });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("назначена");
  });
});
