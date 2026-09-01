import type { Config } from "./config.js";
import type { SecretStore } from "./secrets.js";

export interface AppContext {
  config: Config;
  secrets: SecretStore;
}

let ctx: AppContext | null = null;

export function initContext(c: AppContext): void {
  ctx = c;
}

export function getContext(): AppContext {
  if (!ctx) throw new Error("Контекст приложения не инициализирован");
  return ctx;
}
