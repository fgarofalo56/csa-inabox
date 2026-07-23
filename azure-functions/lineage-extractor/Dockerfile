# CSA Loom lineage-extractor — in-VNet Container App Job image (loom-next-level L3).
# A one-shot Node entrypoint (dist/src/main.js) run once per scheduled execution
# by modules/admin-plane/lineage-extractor-job.bicep. Managed-identity auth only.
# Multi-stage: build with dev deps, ship a slim prod-deps runtime.
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
