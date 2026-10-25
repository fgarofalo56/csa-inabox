# Image for the LHDS health control plane (apps/loom-health-cp).
#
# BUILD CONTEXT IS THE REPO ROOT (matches the other Loom app images):
#
#   docker build -f apps/loom-health-cp/Dockerfile -t loom-health-cp .
#
# Port 8080. Liveness: GET /healthz. Configuration is environment-only; see the
# README for every variable. Cosmos and Entra are reached with the workload's
# managed identity, so no key or connection string is baked in or required.

# ---- build stage -----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /build
COPY apps/loom-health-cp/package.json apps/loom-health-cp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/loom-health-cp/tsconfig.json ./
COPY apps/loom-health-cp/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

# Built-in non-root node user.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/main.js"]

LABEL org.opencontainers.image.title="Loom Health Control Plane"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
