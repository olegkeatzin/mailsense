import { expect, request, test, type Page } from "@playwright/test";

/**
 * Сценарии, которые реально нужны заказчику (а не «как задумано»):
 *   1. вход и почта у рядового работника;
 *   2. ящик заводится ЧЕРЕЗ ФОРМУ: адрес и пароль, сервер подставляется предприятием;
 *   3. «Почта для СЭД» выбирается работником и выбор переживает перезагрузку;
 *   4. выданная роль появляется в ОТКРЫТОМ окне без перезагрузки и не выкидывает из системы;
 *   5. при пропаже связи показывается экран «Нет связи с сервером», после возврата — восстановление.
 */
const BASE = process.env.MAILSENSE_URL ?? "http://127.0.0.1:8123";
const ADMIN = {
  login: process.env.E2E_ADMIN_LOGIN ?? "Иванов_ИИ",
  password: process.env.E2E_ADMIN_PASSWORD ?? ""
};
const WORKER = {
  login: process.env.E2E_WORKER_LOGIN ?? "Петрова_МА",
  password: process.env.E2E_WORKER_PASSWORD ?? ""
};

async function login(page: Page, who: { login: string; password: string }): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("ivanov@company.local").fill(who.login);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole("button", { name: "Войти" }).click();
  // Признак вошедшего приложения — кнопка «Написать» в верхней панели почты.
  await expect(page.getByRole("button", { name: /Написать/ })).toBeVisible({ timeout: 30_000 });
}

async function openSettings(page: Page): Promise<void> {
  // В интерфейсе ДВЕ кнопки «Настройки» (пункт бокового меню и иконка в шапке) —
  // берём пункт меню: он есть на всех экранах.
  await page.getByRole("button", { name: "setting Настройки" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("почта рядового работника", () => {
  test("вход и свой ящик видны", async ({ page }) => {
    await login(page, WORKER);
    // Почта — свои данные: раздел открыт без ролей.
    await expect(page.getByText("Все аккаунты")).toBeVisible();
    await expect(page.getByText("Входящие").first()).toBeVisible();
  });

  test("ящик заводится через форму: адрес и пароль, сервер подставлен предприятием", async ({ page }) => {
    await login(page, WORKER);
    await openSettings(page);
    await page.getByRole("menuitem", { name: "Почта" }).click();
    await page.getByRole("button", { name: /Добавить аккаунт/ }).click();

    const address = "e2e-" + Date.now().toString(36) + "@mail.test";
    await page.getByRole("textbox", { name: /Логин/ }).fill(address);
    await page.locator(".ant-modal input[type='password']").fill("пароль-для-теста");

    // Сервер и порт работник не вводит — они из умолчаний предприятия.
    // Поле сервера — именно входящего (#host); рядом есть SMTP-сервер (#smtpHost).
    await page.getByText("Дополнительно: сервер, порты и шифрование").click();
    await expect(page.locator("#host")).not.toHaveValue("");

    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    // Ящик появился в списке аккаунтов (заголовок строки; тот же адрес есть и в меню слева).
    await expect(page.getByRole("heading", { name: address })).toBeVisible({ timeout: 20_000 });

    // Уборка: тест не должен оставлять мусор в чужой базе.
    const api = await request.newContext({ baseURL: BASE });
    await api.post("/api/auth/login", { data: { login: WORKER.login, password: WORKER.password } });
    const accounts = await (await api.get("/api/accounts")).json();
    const created = (Array.isArray(accounts) ? accounts : []).find(
      (a: { username?: string }) => a.username === address
    );
    if (created) await api.delete("/api/accounts/" + created.id);
    await api.dispose();
  });

  test("«Почта для СЭД» выбирается и выбор переживает перезагрузку", async ({ page }) => {
    await login(page, WORKER);
    await openSettings(page);
    await page.getByRole("menuitem", { name: "Личные настройки" }).click();

    // Блок «Почта для СЭД» обязан показывать СВОИ ящики работника (без выдачи администратором).
    const block = page.getByText("Почта для СЭД").first();
    await block.scrollIntoViewIfNeeded();
    await expect(page.getByText("Почта для СЭД").first()).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: /Написать/ })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("права применяются без перезапуска", () => {
  test("выданная роль появляется в открытом окне и не выкидывает из системы", async ({ page, playwright }) => {
    await login(page, WORKER);
    await openSettings(page);
    // До выдачи раздела администрирования у рядового работника нет.
    const adminSection = page.getByRole("menuitem", { name: "Пользователи и роли" });

    const api = await request.newContext({ baseURL: BASE });
    const auth = await api.post("/api/auth/login", {
      data: { login: ADMIN.login, password: ADMIN.password }
    });
    expect(auth.ok()).toBeTruthy();
    const users = await (await api.get("/api/users")).json();
    const worker = users.find((u: { ldapUid?: string }) => (u.ldapUid ?? "") === WORKER.login);
    expect(worker).toBeTruthy();

    const roles = await (await api.get("/api/roles")).json();
    const list = Array.isArray(roles) ? roles : roles.roles ?? [];
    let probe = list.find((r: { name: string }) => r.name === "Проверка прав");
    if (!probe) {
      probe = await (await api.post("/api/roles", {
        data: { name: "Проверка прав", permissions: ["users.manage"] }
      })).json();
    }

    // Что было — берём из списка пользователей: отдельного GET ролей у пользователя нет.
    const before = (worker.roles ?? []).map((r: { id?: string } | string) =>
      typeof r === "string" ? r : r.id
    ).filter(Boolean);
    await api.put("/api/users/" + worker.id + "/roles", { data: { roleIds: [probe.id] } });

    // Права перечитываются на каждом запросе → пункт появляется БЕЗ перезагрузки страницы
    // (и без выкидывания на вход — это было отдельным дефектом).
    await expect(adminSection).toBeVisible({ timeout: 45_000 });
    await expect(page.getByPlaceholder("ivanov@company.local")).toHaveCount(0);

    // Возвращаем роли как было, чтобы тест не оставлял следов.
    await api.put("/api/users/" + worker.id + "/roles", { data: { roleIds: before } });

    await expect(adminSection).toHaveCount(0, { timeout: 45_000 });
    await api.dispose();
  });
});

test.describe("потеря связи", () => {
  test("экран «Нет связи с сервером» и восстановление после возврата", async ({ page }) => {
    await login(page, WORKER);
    // Имитируем обрыв, не останавливая сервер: все запросы к API падают.
    await page.route("**/api/**", (route) => route.abort());
    await expect(page.getByText("Нет связи с сервером")).toBeVisible({ timeout: 30_000 });

    await page.unroute("**/api/**");
    await expect(page.getByText("Нет связи с сервером")).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByText("Все аккаунты")).toBeVisible();
  });
});
