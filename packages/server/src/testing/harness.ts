import http from "node:http";
import type express from "express";

/**
 * Мини-стенд для тестов сервера: настоящее HTTP-соединение вместо подделки req/res.
 *
 * Проверяем поведение снаружи — кодами ответа и телом, — поэтому middleware
 * прогоняются ровно так же, как в бою, вместе с порядком маршрутов Express.
 */

export interface RunningApp {
  baseUrl: string;
  close(): Promise<void>;
}

/** Поднимает приложение (или любой request-listener) на свободном порту 127.0.0.1. */
export async function listen(app: express.Express | http.RequestListener): Promise<RunningApp> {
  const server = http.createServer(app as http.RequestListener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: "http://127.0.0.1:" + port,
    async close() {
      // Иначе keep-alive соединения fetch не дают серверу закрыться.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export interface HttpResult {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
}

export interface RequestOptions {
  /** Токен сессии: уходит в Authorization, как в сквозных скриптах проверки. */
  token?: string | null;
  /** Тело как JSON. */
  body?: unknown;
  /** Тело как есть — нужно, чтобы проверить лимит размера и битый JSON. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = "Bearer " + options.token;
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  const res = await fetch(baseUrl + path, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Проверяет, что процесс жив: следующий запрос обслуживается. */
export async function stillAlive(baseUrl: string): Promise<boolean> {
  try {
    const res = await request(baseUrl, "GET", "/api/health");
    return res.status === 200;
  } catch {
    return false;
  }
}
