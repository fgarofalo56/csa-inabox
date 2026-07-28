# CSA Loom lineage-extractor — in-VNet Container App Job image (loom-next-level L3).
# A one-shot Node entrypoint (dist/src/main.js) run once per scheduled execution
# by modules/admin-plane/lineage-extractor-job.bicep. Managed-identity auth only.
# Multi-stage: build with dev deps, ship a slim prod-deps runtime.
# B-SC1' (loom-apex): node 20 "Iron" is END-OF-LIFE (2026-04-30) and its Docker
# tags stopped being rebuilt 2026-04-22 — moved to node 22 "Jod" (LTS through
# 2027-04-30), same major as every other Loom node image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# B-SC1' (loom-apex): drop the bundled npm/npx from the RUNTIME layer once the
# prod deps are installed. The job entrypoint is `node dist/src/main.js` and
# never shells out to a package manager; npm vendors its own node-tar
# (CVE-2026-59873 gzip-bomb DoS, fixed in tar >= 7.5.19, which no node base
# image bundles yet), so removing it eliminates the vulnerable code outright.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /root/.npm
COPY --from=build /app/dist ./dist
# Non-root for least privilege (the base image ships a `node` user).
USER node
CMD ["node", "dist/src/main.js"]
