import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeSecretStore, PlainSecretStore } from "./secrets.js";

/**
 * Секреты (пароли почты, пароль сервисной учётки каталога) лежат зашифрованными.
 * Ключ — в файле рядом с данными, поэтому проверяем и стойкость, и переживание
 * перезапуска: без этого после рестарта пароли станут нечитаемыми.
 */
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-secrets-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("NodeSecretStore", () => {
  test("шифрует и расшифровывает обратно", () => {
    const s = new NodeSecretStore(dir);
    const cipher = s.encrypt("Пароль123!");
    expect(cipher).not.toContain("Пароль123!");
    expect(s.decrypt(cipher)).toBe("Пароль123!");
  });

  test("кириллица и спецсимволы не портятся", () => {
    const s = new NodeSecretStore(dir);
    const plain = "Пароль с пробелами & знаками <>&\"№";
    expect(s.decrypt(s.encrypt(plain))).toBe(plain);
  });

  test("одинаковый пароль даёт разные шифротексты (свой IV на каждый раз)", () => {
    const s = new NodeSecretStore(dir);
    expect(s.encrypt("same")).not.toBe(s.encrypt("same"));
  });

  test("ключ сохраняется в файл и переживает перезапуск", () => {
    const first = new NodeSecretStore(dir);
    const cipher = first.encrypt("секрет");

    // Новый экземпляр читает тот же ключ: иначе после рестарта пароли не расшифруются.
    const second = new NodeSecretStore(dir);
    expect(second.decrypt(cipher)).toBe("секрет");
    expect(fs.existsSync(path.join(dir, "secret.key"))).toBe(true);
  });

  test("подмена шифротекста обнаруживается (AES-GCM)", () => {
    const s = new NodeSecretStore(dir);
    const cipher = s.encrypt("секрет");
    const parts = cipher.split(".");
    // меняем последний символ данных
    const bad = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA")].join(".");
    expect(() => s.decrypt(bad)).toThrow();
  });

  test("мусор вместо шифротекста отклоняется понятной ошибкой", () => {
    const s = new NodeSecretStore(dir);
    expect(() => s.decrypt("просто-строка")).toThrow(/формат/);
    expect(() => s.decrypt("v2.a.b.c")).toThrow(/формат/);
  });

  test("битый файл ключа отклоняется на старте, а не при первом пароле", () => {
    fs.writeFileSync(path.join(dir, "secret.key"), "слишком-короткий-ключ");
    expect(() => new NodeSecretStore(dir)).toThrow(/ключ/i);
  });

  test("ключ создаётся с правами только для владельца", () => {
    new NodeSecretStore(dir);
    const mode = fs.statSync(path.join(dir, "secret.key")).mode & 0o777;
    // На Windows права POSIX не применяются — проверяем только на POSIX-системах.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    else expect(mode).toBeGreaterThan(0);
  });
});

describe("PlainSecretStore (фолбэк без шифрования)", () => {
  test("помечает значение префиксом и возвращает обратно", () => {
    const s = new PlainSecretStore();
    const c = s.encrypt("секрет");
    expect(c).toBe("plain:секрет");
    expect(s.decrypt(c)).toBe("секрет");
  });

  test("значение без префикса возвращается как есть (совместимость)", () => {
    expect(new PlainSecretStore().decrypt("старое-значение")).toBe("старое-значение");
  });
});
