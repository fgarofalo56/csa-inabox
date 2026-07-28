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

# B-SC1' (loom-apex): node 20 "Iron" is END-OF-LIFE (2026-04-30) and every
# `node:20*` tag stopped being rebuilt on 2026-04-22 — no further base security
# patches are possible. Moved to node 22 "Jod" (LTS through 2027-04-30), pinning
# `-bookworm-slim` explicitly because the moving `-slim` alias now resolves to
# Debian trixie and the apt set below is validated on Debian 12.
FROM node:22-bookworm-slim

WORKDIR /app

# Install curl for the container HEALTHCHECK, then prune apt lists. The leading
# dist-upgrade pulls the distro's security patches ahead of the pinned base tag
# (the mcp-bridge pattern). Pinned base image — bump deliberately with security
# review.
RUN apt-get update && apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Dependency layer first (cache-friendly). --omit=dev: only @azure/cosmos +
# @azure/identity ship; there are no build/test-only deps (tests use node:test).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# B-SC1' (loom-apex): drop the bundled npm/npx once dependencies are installed.
# The entrypoint is `node src/server.mjs`; nothing here shells out to a package
# manager. npm vendors its own node-tar (CVE-2026-59873, gzip-bomb DoS, fixed in
# tar >= 7.5.19 which no node base image bundles yet) — removing the unused
# package manager eliminates the vulnerable code instead of suppressing it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /root/.npm

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
