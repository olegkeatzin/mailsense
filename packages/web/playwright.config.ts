import { defineConfig, devices } from "@playwright/test";

/**
 * Браузерные проверки интерфейса на ЖИВОМ сервере.
 *
 * Зачем: правки интерфейса по правилам проекта обязаны проверяться в настоящем браузере
 * за две роли. До этого такой проверки в проекте не было — «посмотрел глазами» ничего
 * не доказывает (и уже пропускало настоящие дефекты).
 *
 * Запуск против своего сервера:
 *
 *   $env:MAILSENSE_URL="http://127.0.0.1:8123"
 *   $env:E2E_ADMIN_LOGIN="Иванов_ИИ"; $env:E2E_ADMIN_PASSWORD="..."
 *   $env:E2E_WORKER_LOGIN="Петрова_МА"; $env:E2E_WORKER_PASSWORD="..."
 *   pnpm exec playwright test
 *
 * ⚠️ Тесты создают и удаляют СВОЙ почтовый ящик и меняют роли тестовому работнику:
 * на боевом контуре запускайте на тестовых учётках.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.MAILSENSE_URL ?? "http://127.0.0.1:8123",
    ignoreHTTPSErrors: true,
    locale: "ru-RU",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
