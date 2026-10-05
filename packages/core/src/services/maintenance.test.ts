import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initApp } from "../init.js";
import { closeDb } from "../db/index.js";
import { getSetting, setSetting } from "../repos.js";
import { runStartupMaintenance } from "./maintenance.js";

/**
 * Обслуживание данных выполняется один раз на версию: иначе при каждом старте
 * пересобирались бы все беседы и снимались статусы — на большом ящике это долго.
 */
let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-maint-"));
  // initApp сам запускает обслуживание — это и есть первый прогон.
  initApp({ dataDir: dir });
});

afterAll(() => {
  // На Windows открытый файл базы не удаляется — сначала закрываем соединение.
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог уберёт система */
  }
});

describe("обслуживание при старте", () => {
  test("при первом старте проставляет версию", () => {
    expect(getSetting("maintenance.version")).not.toBeNull();
  });

  test("повторный запуск пропускается", () => {
    const r = runStartupMaintenance();
    expect(r.ran).toBe(false);
    expect(r.resetStatuses).toBe(0);
    expect(r.rethreaded).toBe(0);
  });

  test("принудительный запуск выполняется снова", () => {
    // force нужен, когда починку надо повторить вручную после сбоя.
    const r = runStartupMaintenance(true);
    expect(r.ran).toBe(true);
  });

  test("смена версии запускает обслуживание заново", () => {
    setSetting("maintenance.version", "0");
    const r = runStartupMaintenance();
    expect(r.ran).toBe(true);
    expect(getSetting("maintenance.version")).not.toBe("0");
  });

  test("пустая база не мешает обслуживанию", () => {
    const r = runStartupMaintenance(true);
    expect(r.ran).toBe(true);
    expect(r.resetStatuses).toBe(0);
  });
});
