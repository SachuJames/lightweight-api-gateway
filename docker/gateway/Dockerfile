# syntax=docker/dockerfile:1
# Gateway image: builds the TypeScript service and ships a production-only
# runtime. Run with the provided docker-compose.yml or:
#   docker build -f docker/gateway/Dockerfile -t lightweight-gateway .
#   docker run -e DATABASE_URL=... -e REDIS_URL=... -e JWT_SECRET=... -p 8080:8080 lightweight-gateway

FROM node:24-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile

COPY packages/shared-types ./packages/shared-types
COPY apps/gateway ./apps/gateway
RUN pnpm --filter gateway build
RUN pnpm --filter gateway deploy --prod /deploy

FROM node:24-alpine AS runner
ENV NODE_ENV=production
RUN addgroup -S gateway && adduser -S gateway -G gateway
WORKDIR /app
COPY --from=builder --chown=gateway:gateway /deploy ./
COPY --chown=gateway:gateway docker/gateway/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
USER gateway
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]
