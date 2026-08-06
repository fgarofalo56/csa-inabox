# CSA Loom report-subscriptions — in-VNet Container App Job image (WS-C2).
# A one-shot Node entrypoint (dist/src/main.js) run once per scheduled execution
# by modules/admin-plane/report-subscriptions-job.bicep. Managed-identity auth
# only (the console UAMI) — no storage keys, no Functions host.
#
# B-FN migration (C3, 2026-08-06): replaces the Y1 Consumption Function
# packaging. Y1 is structurally broken on this estate (sealed storage
# data-plane, AAD-only, no private endpoint, Y1 is not a trusted service), so
# all scheduled compute runs as an in-VNet ACA job. Measured 2026-08-06:
# `az functionapp function list` returned [] for every Function App in
# rg-csa-loom-admin-centralus, so the retired timer had never fired.
# Mirrors azure-functions/secret-expiry-monitor.
#
# Build context: azure-functions/report-subscriptions (self-contained).
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
