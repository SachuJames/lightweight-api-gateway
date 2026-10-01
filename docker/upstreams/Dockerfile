# syntax=docker/dockerfile:1
# Example upstream services (users, orders, slow, failing). One Dockerfile,
# parameterized by build arg; docker-compose.yml passes SERVICE for each.
#   docker build --build-arg SERVICE=users -f docker/upstreams/Dockerfile -t users-svc .

ARG SERVICE=users

FROM node:24-alpine AS runner
ARG SERVICE
ENV PORT=3000
WORKDIR /srv
COPY examples/upstreams/${SERVICE}/server.js ./server.js
RUN addgroup -S upstream && adduser -S upstream -G upstream && chown upstream:upstream /srv/server.js
USER upstream
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "server.js"]
