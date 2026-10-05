# MailSense — серверная часть (документооборот + почтовый шлюз).
#
# Собирает workspace и запускает standalone-сервер: он же опрашивает почтовые ящики,
# он же отдаёт REST API и SPA. Клиент (браузер или Electron) подключается по сети.
#
#   docker build -f docker/Dockerfile -t mailsense .
#   docker run -d -p 8123:8123 -v mailsense-data:/data \
#     -e MAILSENSE_ADMIN_LOGINS=<доменный логин> \
#     -e MAILSENSE_ADMIN_PASSWORD=<пароль> mailsense
#
# ВАЖНО: Node >= 22 — better-sqlite3@13 собран под N-API 10.

# ---------- сборка ----------
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app

# Манифесты отдельным слоем: пока они не менялись, зависимости берутся из кэша.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/docflow/package.json packages/docflow/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY apps/electron/package.json apps/electron/
# Electron для серверного образа не нужен: ставим только нужные пакеты.
RUN pnpm install --frozen-lockfile --filter @mailsense/core --filter @mailsense/docflow --filter @mailsense/server --filter @mailsense/web

COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm --filter @mailsense/core build \
 && pnpm --filter @mailsense/docflow build \
 && pnpm --filter @mailsense/server build \
 && pnpm --filter @mailsense/web build

# ---------- рантайм ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MAILSENSE_DATA_DIR=/data \
    MAILSENSE_HOST=0.0.0.0 \
    MAILSENSE_PORT=8123
WORKDIR /app

RUN corepack enable && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages ./packages

# Данные (обе базы, вложения, ключ шифрования) — в томе, а не в слое образа.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8123

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILSENSE_PORT||8123)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/bin/server.js"]
