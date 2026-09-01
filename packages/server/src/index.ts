import type { Config, SecretStore } from "@mailsense/core";
import { initApp, startMailScheduler } from "@mailsense/core";
import { createApp } from "./app.js";
import type http from "node:http";

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  webDist?: string;
  overrides?: Partial<Config>;
  secretStore?: SecretStore;
}

export interface RunningServer {
  config: Config;
  httpServer: http.Server;
  url: string;
  app: ReturnType<typeof createApp>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const init = initApp(
    options.dataDir ? { ...(options.overrides ?? {}), dataDir: options.dataDir } : options.overrides,
    options.secretStore
  );
  const app = createApp({ webDist: options.webDist });
  startMailScheduler();
  const port = options.port ?? init.config.port;
  const host = options.host ?? init.config.host;

  return new Promise<RunningServer>((resolve) => {
    const httpServer = app.listen(port, host, () => {
      resolve({
        config: init.config,
        httpServer,
        url: "http://" + host + ":" + port,
        app
      });
    });
  });
}

export { createApp };
