FROM oven/bun:1.4.2-alpine AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/gateway/desktop/package.json apps/gateway/desktop/package.json
COPY apps/connector/package.json apps/connector/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --filter 'copilot-api-gateway' --ignore-scripts

COPY . .
RUN bun run --cwd apps/gateway build

FROM oven/bun:1.4.2-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NODE_USE_SYSTEM_CA=1 \
    COPILOT_API_HOME=/data

COPY package.json bun.lock bunfig.toml ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/gateway/desktop/package.json apps/gateway/desktop/package.json
COPY apps/connector/package.json apps/connector/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --filter 'copilot-api-gateway' --production --ignore-scripts --no-cache

COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder /app/apps/gateway/pages ./apps/gateway/pages
COPY apps/gateway/entrypoint.sh /entrypoint.sh
WORKDIR /app/apps/gateway

RUN chmod +x /entrypoint.sh && \
    mkdir -p /data && \
    chown bun:bun /data && \
    chmod 700 /data

USER bun
VOLUME ["/data"]
EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["wget", "--spider", "-q", "-T", "4", "-Y", "off", "http://127.0.0.1:4141/"]

ENTRYPOINT ["/entrypoint.sh"]
