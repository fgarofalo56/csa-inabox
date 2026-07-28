# CSA Loom — MCP stdio→HTTP/SSE bridge
#
# Runs npx/uvx-launched stdio MCP servers inside the Loom Admin Plane and
# exposes each over HTTP/SSE on :8080, producing the conformant HTTP endpoint
# the Loom Console External-MCP panel + copilot-orchestrator already consume.
#
# Build: docker build -t loom-mcp-bridge .
# Run:   docker run -p 8080:8080 -e AZURE_CLOUD=AzureCloud loom-mcp-bridge

# B-SC1' (loom-apex): node 20 "Iron" is END-OF-LIFE (2026-04-30, nodejs/Release
# schedule.json) and Docker Hub froze every `node:20*` tag on 2026-04-22, so the
# base can never receive another security rebuild. Moved to node 22 "Jod" (LTS
# through 2027-04-30). The `-bookworm-slim` variant is pinned EXPLICITLY rather
# than the moving `-slim` alias: `node:22-slim` now resolves to Debian trixie,
# and the apt package set + `uv` install below are validated on Debian 12.
FROM node:22-bookworm-slim

# uv/uvx (Python stdio MCP servers) + the toolchain npx/uvx need to fetch and
# run packages at runtime. git is required by mcp-server-git and by npx for
# git-hosted specs. Pinned base + apt for a reproducible, security-reviewable
# image — bump deliberately. The leading dist-upgrade pulls the distro's
# security patches ahead of the pinned base tag (SC1 trivy CRITICAL gate —
# e.g. libgnutls30 CVE-2026-42010 AND CVE-2026-33845, both fixed in
# gnutls28 3.7.9-2+deb12u7, which the base tag predates).
RUN apt-get update && apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# B-SC1' (loom-apex): npm ships a VENDORED copy of node-tar. Every node base
# image still bundles a vulnerable one (node 22.23.1 -> npm 10.9.8 -> tar
# 7.5.11; node 26.5.0 -> npm 11.17.0 -> tar 7.5.16), and CVE-2026-59873
# (node-tar gzip-bomb DoS) is only fixed in tar >= 7.5.19 — first bundled by
# npm 11.18.0 (verified: the published npm 11.18.0 tarball carries
# node_modules/tar 7.5.19). This bridge SPAWNS `npx` at runtime
# (src/stdio-client.mjs), so npm cannot simply be deleted the way it is in the
# console image — it is upgraded in place instead. npm 11 requires node
# ^20.17.0 || >=22.9.0, satisfied by the node 22 base above.
ARG NPM_VERSION=11.18.0
RUN npm install -g "npm@${NPM_VERSION}" \
    && npm --version \
    && npm cache clean --force

# Install uv (provides uvx) into a system location on PATH.
# Pinned to a known-good release — bump explicitly with security review.
ARG UV_VERSION=0.5.11
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin sh \
    && /usr/local/bin/uv --version

WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Non-root user. Pre-create caches it owns so npx/uvx can write at runtime.
RUN groupadd --system loom && useradd --system --gid loom --create-home loom \
    && mkdir -p /home/loom/.npm /home/loom/.cache/uv \
    && chown -R loom:loom /app /home/loom
USER loom
ENV HOME=/home/loom \
    npm_config_cache=/home/loom/.npm \
    UV_CACHE_DIR=/home/loom/.cache/uv

# Bridge config + listen port. AZURE_CLOUD selects the boundary catalog filter.
ENV LOOM_MCP_BRIDGE_CONFIG=/app/config/loom-mcp-bridge.json \
    LOOM_MCP_BRIDGE_PORT=8080 \
    AZURE_CLOUD=AzureCloud
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/.well-known/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
