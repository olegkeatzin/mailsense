import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Хранилище секретов. Интерфейс единый, реализаций две:
 * - NodeSecretStore: AES-256-GCM + локальный ключ-файл (headless/тест).
 * - SafeStorageSecretStore: Electron safeStorage (в apps/electron), с фолбэком на NodeSecretStore.
 */
export interface SecretStore {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const KEY_FILE = "secret.key";

export class NodeSecretStore implements SecretStore {
  private key: Buffer;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const keyPath = path.join(dataDir, KEY_FILE);
    if (fs.existsSync(keyPath)) {
      this.key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
    } else {
      this.key = randomBytes(32);
      fs.writeFileSync(keyPath, this.key.toString("hex"), { mode: 0o600 });
      logger.info({ keyPath }, "Создан новый ключ шифрования секретов");
    }
    if (this.key.length !== 32) {
      throw new Error("Некорректный ключ шифрования секретов");
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
  }

  decrypt(cipher: string): string {
    const [ver, ivB64, tagB64, dataB64] = cipher.split(".");
    if (ver !== "v1" || !ivB64 || !tagB64 || !dataB64) {
      throw new Error("Некорректный формат зашифрованного секрета");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

/** Fallback без шифрования (только для случаев, когда ключ недоступен). */
export class PlainSecretStore implements SecretStore {
  encrypt(plain: string): string {
    return "plain:" + plain;
  }
  decrypt(cipher: string): string {
    return cipher.startsWith("plain:") ? cipher.slice(6) : cipher;
  }
}
