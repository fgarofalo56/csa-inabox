# CSA Loom Console — Next.js multi-stage Dockerfile
# Public brand: Loom Console; repo-internal: fiab-console
#
# Status: SCAFFOLDED — production image per PRP-03

# ============================================================
# Stage 1 — dependencies
# ============================================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
# Use --no-frozen-lockfile until pnpm-lock.yaml is committed
# (pnpm install --lockfile-only generates it).
RUN npm install -g pnpm@9 && \
    pnpm install --no-frozen-lockfile

# ============================================================
# Stage 2 — builder
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The Next build OOMed in the ACR Tasks container (JS heap out of memory) as the
# app grew — give Node a larger old-space heap. 4096 became the ceiling again on
# 2026-07-02 (run cj9h: Mark-Compact 3.6GB → SIGABRT), so 6144; the default ACR
# Tasks agent has 8 GB RAM.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm install -g pnpm@9 && \
    pnpm build

# ============================================================
# Stage 3 — runner (production)
# ============================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time marker — populated by CI from --build-arg LOOM_BUILD_SHA=...
# Embeds the git SHA into the image itself and stamps /public/build-marker.txt
# so deploy-validation can definitively prove which build is serving.
ARG LOOM_BUILD_SHA=unknown
ARG LOOM_BUILD_TIMESTAMP=unknown
ENV LOOM_BUILD_SHA=${LOOM_BUILD_SHA}
ENV LOOM_BUILD_TIMESTAMP=${LOOM_BUILD_TIMESTAMP}

# Optional: bundle the Pylance-grade Python language server (pylsp + pyright)
# into the image for the Data Science notebook variant. Off by default so the
# base Console image stays lean; CI builds the notebook image with
# `--build-arg LOOM_INCLUDE_PYLSP=true`. At runtime the bridge only spawns pylsp
# when LOOM_PYLSP_ENABLED is set (see instrumentation.ts), so an image built
# without this layer simply reports lspAvailable:false and falls back to
# Monaco's built-in completions. pandas/numpy give real member completions for
# `import pandas as pd; pd.read_` via pandas-stubs that pyright reads.
ARG LOOM_INCLUDE_PYLSP=false
RUN if [ "$LOOM_INCLUDE_PYLSP" = "true" ]; then \
      apk add --no-cache python3 py3-pip && \
      pip3 install --no-cache-dir --break-system-packages \
        "python-lsp-server[all]>=1.11.0" \
        "pyright>=1.1.350" \
        "pandas-stubs>=2.2.0" \
        pandas numpy && \
      ln -sf "$(command -v python3)" /usr/local/bin/python3 ; \
    fi
ENV LOOM_PYLSP_PYTHON=python3

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Repo-hosted app-bundle sample datasets. They live inside the fiab-console
# package (so they're in the Docker build context) but are NOT part of Next's
# traced standalone output, so copy them explicitly next to server.js. At
# runtime lib/apps/repo-datasets.ts reads them from <cwd>/samples/app-data and
# the install provisioner uploads them into the tenant's own ADLS.
COPY --from=builder --chown=nextjs:nodejs /app/samples ./samples

# Overwrite any source-tree marker with one stamped at build time.
# Validator probes /build-marker.txt and grep's for sha=<expected>.
RUN echo "loom-build-marker sha=${LOOM_BUILD_SHA} stamp=${LOOM_BUILD_TIMESTAMP} token=LOOM_LIVE_BUILD" > /app/public/build-marker.txt && \
    chown nextjs:nodejs /app/public/build-marker.txt

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]

# Labels for ACR + supply-chain
LABEL org.opencontainers.image.title="Loom Console"
LABEL org.opencontainers.image.description="CSA Loom Console — Microsoft Fabric experience for Azure tenants"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL org.opencontainers.image.licenses="MIT"
LABEL csa.loom.component="console"
LABEL csa.loom.version="0.1.0-scaffold"
