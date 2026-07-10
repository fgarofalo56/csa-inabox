# CSA Loom — Loom OneLake namespace/catalog service (HYP-1)
#
# Internal-ingress ACA app exposing the loom:// resolver + Cosmos-backed
# namespace registry. Node built-ins for the HTTP transport (the mcp-bridge
# pattern); @azure/cosmos + @azure/identity for the real registry backend.
#
# Build: docker build -t loom-onelake .
# Run:   docker run -p 8080:8080 \
#          -e LOOM_ONELAKE_DEFAULT_ACCOUNT=<dlz-acct> \
#          -e LOOM_ONELAKE_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
#          loom-onelake
#
# Azure-native only — no Microsoft Fabric / OneLake / Power BI dependency.

FROM node:20-slim

WORKDIR /app

# Install curl for the container HEALTHCHECK, then prune apt lists. Pinned base
# image — bump deliberately with security review.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Dependency layer first (cache-friendly). --omit=dev: only @azure/cosmos +
# @azure/identity ship; there are no build/test-only deps (tests use node:test).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY tests/ ./tests/

# Non-root user (the ACA app exposes its UAMI via IMDS to in-container code —
# least-privilege identity + non-root user is the layered defence).
RUN groupadd --system loom && useradd --system --gid loom --uid 10001 --create-home loom \
    && chown -R loom:loom /app
USER loom
ENV HOME=/home/loom \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["node", "src/server.mjs"]

LABEL org.opencontainers.image.title="Loom OneLake"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="loom-onelake"
LABEL csa.loom.version="0.1.0"
