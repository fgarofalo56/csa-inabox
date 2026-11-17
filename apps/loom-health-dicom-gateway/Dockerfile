# Image for the LHDS DICOMweb gateway (apps/loom-health-dicom-gateway, W3-3).
#
# BUILD CONTEXT IS THE REPO ROOT (matches loom-health-cp):
#
#   docker build -f apps/loom-health-dicom-gateway/Dockerfile -t loom-health-dicom-gateway .
#
# Port 8080. Liveness: GET /healthz. Configuration is environment-only; see the
# README. The image holds no clinical data and no secret: the PDP and the per-tenant
# archives are reached over the cluster network, and the Loom token is verified by
# the PDP, not here. Zero runtime dependencies (node:http only).

# ---- build stage -----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /build
COPY apps/loom-health-dicom-gateway/package.json apps/loom-health-dicom-gateway/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/loom-health-dicom-gateway/tsconfig.json ./
COPY apps/loom-health-dicom-gateway/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist ./dist

# Built-in non-root node user.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/main.js"]

LABEL org.opencontainers.image.title="Loom Health DICOMweb Gateway"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
