# CSA Loom copilot-evaluator — in-VNet Container App Job image (E2/SRCH1/E6).
# A one-shot Node entrypoint run once per scheduled (or on-demand) execution by
# modules/admin-plane/copilot-evaluator-job.bicep. Managed-identity auth only
# (the console UAMI) — no Functions host, no host keys, no host storage.
#
# B-FN migration (2026-07-27): replaces the Y1 Consumption Function packaging.
# Y1 is structurally broken on this estate (sealed storage data-plane, AAD-only,
# no private endpoint, Y1 is not a trusted service), so all scheduled compute
# runs as an in-VNet ACA job.
#
# BUILD CONTEXT MUST BE THE REPO ROOT — the evaluator imports two shared pure
# console modules (lib/foundry/model-tier-router + its availability matrix, and
# the LoomCloud type from lib/azure/cloud-endpoints) per the E2 "shared pure
# modules, import-both" rule, and stages the E1 golden eval sets from
# content/evals. tsconfig rootDir is ../.. for the same reason, so the compiled
# tree is dist/azure-functions/copilot-evaluator/src/**.
#
#   docker build -f azure-functions/copilot-evaluator/Dockerfile .
#   az acr build --registry <acr> --image loom-copilot-evaluator:latest \
#     --file azure-functions/copilot-evaluator/Dockerfile .

FROM node:20-bookworm-slim AS build
WORKDIR /repo/azure-functions/copilot-evaluator
COPY azure-functions/copilot-evaluator/package*.json azure-functions/copilot-evaluator/tsconfig.json ./
RUN npm ci
COPY azure-functions/copilot-evaluator/src ./src
COPY azure-functions/copilot-evaluator/scripts ./scripts
# Shared pure console modules the evaluator imports (type + logic reuse).
COPY apps/fiab-console/lib/foundry/model-tier-router.ts /repo/apps/fiab-console/lib/foundry/model-tier-router.ts
COPY apps/fiab-console/lib/foundry/model-availability-matrix.ts /repo/apps/fiab-console/lib/foundry/model-availability-matrix.ts
COPY apps/fiab-console/lib/azure/cloud-endpoints.ts /repo/apps/fiab-console/lib/azure/cloud-endpoints.ts
# E1 golden eval sets — staged into ./evals so the image is self-contained
# (resolveEvalRoot checks ./evals first; no external fetch at IL5).
COPY content/evals /repo/content/evals
RUN npm run build && node scripts/stage-evals.mjs

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY azure-functions/copilot-evaluator/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /repo/azure-functions/copilot-evaluator/dist ./dist
COPY --from=build /repo/azure-functions/copilot-evaluator/evals ./evals
# Non-root for least privilege (the base image ships a `node` user).
USER node
CMD ["node", "dist/azure-functions/copilot-evaluator/src/main.js"]
