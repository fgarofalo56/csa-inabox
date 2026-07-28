# CSA Loom secret-expiry-monitor — in-VNet Container App Job image (S1).
# A one-shot Node entrypoint (dist/src/main.js) run once per scheduled execution
# by modules/admin-plane/secret-expiry-monitor-job.bicep. Managed-identity auth
# only (the console UAMI) — no storage keys, no Functions host.
#
# B-FN migration (2026-07-27): replaces the Y1 Consumption Function packaging.
# Y1 is structurally broken on this estate (sealed storage data-plane, AAD-only,
# no private endpoint, Y1 is not a trusted service), so all scheduled compute
# runs as an in-VNet ACA job. Mirrors azure-functions/lineage-extractor.
#
# Build context: azure-functions/secret-expiry-monitor (self-contained).
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Non-root for least privilege (the base image ships a `node` user).
USER node
CMD ["node", "dist/src/main.js"]
