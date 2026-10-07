import { parseRemoteSessionUser, remoteSessionAuthUser } from "./auth.js";

// ./auth.js тянет за собой docflow, а его исходники — @mailsense/core/directory; в конфиге
// серверных тестов этот подпуть не отображён, поэтому подставляем обычные моки.
jest.mock("@mailsense/core", () => require("./testing/mocks.js").coreMockModule());
jest.mock("@mailsense/docflow", () => require("./testing/mocks.js").docflowMockModule());

/**
 * Кэш подтверждённой сессии режима клиента (T45).
 *
 * По вердикту безопасности мы держим в памяти локального процесса минимум о работнике:
 * id, логин каталога и ФИО. Роли и права удалённого пользователя не нужны — локальные
 * маршруты (личный профиль) прав не проверяют, а полномочия в кэше были бы лишним риском.
 */
describe("разбор ответа удалённой сессии: только id, логин и ФИО", () => {
  test("роли и права отбрасываются, даже если сервер их прислал", () => {
    const user = parseRemoteSessionUser({
      user: {
        id: "u-1",
        ldapUid: "ivanov_ii",
        fullName: "Иванов И.И.",
        email: "ivanov@stand.test",
        roles: ["admin"],
        permissions: ["settings.manage", "mail.view"]
      }
    });

    expect(user).toEqual({ id: "u-1", ldapUid: "ivanov_ii", fullName: "Иванов И.И." });
    // Ключей ролей и прав в записи нет вообще — не «пустые», а отсутствуют.
    expect(Object.keys(user!).sort()).toEqual(["fullName", "id", "ldapUid"]);
  });

  test("без пользователя или без id сессия не подтверждается", () => {
    expect(parseRemoteSessionUser({ user: null })).toBeNull();
    expect(parseRemoteSessionUser({})).toBeNull();
    expect(parseRemoteSessionUser(null)).toBeNull();
    expect(parseRemoteSessionUser({ user: { fullName: "Без id" } })).toBeNull();
  });

  test("логин может отсутствовать (локальный администратор) — ключом станет id", () => {
    expect(parseRemoteSessionUser({ user: { id: "u-local", fullName: "Локальный" } })).toEqual({
      id: "u-local",
      ldapUid: null,
      fullName: "Локальный"
    });
  });
});

describe("req.user режима клиента собирается без полномочий", () => {
  test("роли и права пустые, идентификация и ФИО сохранены", () => {
    const reqUser = remoteSessionAuthUser({ id: "u-1", ldapUid: "ivanov_ii", fullName: "Иванов И.И." });

    expect(reqUser).toMatchObject({ id: "u-1", ldapUid: "ivanov_ii", fullName: "Иванов И.И." });
    // ⚠️ Даже если локальная проверка прав когда-нибудь появится, из кэша она прав не получит.
    expect(reqUser.roles).toEqual([]);
    expect(reqUser.permissions).toEqual([]);
  });
});
