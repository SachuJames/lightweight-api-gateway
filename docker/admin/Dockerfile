# syntax=docker/dockerfile:1
# Admin UI image: builds the Vite SPA and serves it with nginx.
# The API base URL is baked in at build time via VITE_API_BASE_URL
# (defaults to same-origin). Rebuild to point at a different gateway.

FROM node:24-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile

COPY packages/shared-types ./packages/shared-types
COPY apps/admin ./apps/admin
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter admin-ui build

FROM nginx:1.27-alpine AS runner
COPY docker/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
