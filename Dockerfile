# syntax=docker/dockerfile:1
# People Pulse production image (S-69). Node 24 satisfies package.json engines (>=22.13; node:sqlite needs >=22.5).

# ---- build: full dependency tree, vite bundle + server/script bundles -> dist/
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- deps: production dependencies only (vite/tsx/playwright are not needed at runtime)
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    CIVIC_DB=/var/lib/pulse/civic.db \
    CIVIC_MEDIA_DIR=/var/lib/pulse/media \
    CIVIC_AUDIT_ANCHOR_FILE=/var/lib/pulse/anchors/audit-anchors.jsonl \
    CIVIC_BACKUP_DIR=/var/lib/pulse/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/data/generated ./data/generated
COPY --from=build /app/data/civic ./data/civic
COPY package.json ./
# State lives only under /var/lib/pulse (civic DB, media, audit anchors, backups): mount ONE volume there.
RUN mkdir -p /var/lib/pulse/media /var/lib/pulse/anchors /var/lib/pulse/backups && chown -R node:node /var/lib/pulse /app
VOLUME ["/var/lib/pulse"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
