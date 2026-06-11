# CSA Loom — MCP stdio→HTTP/SSE bridge
#
# Runs npx/uvx-launched stdio MCP servers inside the Loom Admin Plane and
# exposes each over HTTP/SSE on :8080, producing the conformant HTTP endpoint
# the Loom Console External-MCP panel + copilot-orchestrator already consume.
#
# Build: docker build -t loom-mcp-bridge .
# Run:   docker run -p 8080:8080 -e AZURE_CLOUD=AzureCloud loom-mcp-bridge

FROM node:20-slim

# uv/uvx (Python stdio MCP servers) + the toolchain npx/uvx need to fetch and
# run packages at runtime. git is required by mcp-server-git and by npx for
# git-hosted specs. Pinned base + apt for a reproducible, security-reviewable
# image — bump deliberately.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

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
