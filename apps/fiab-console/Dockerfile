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
# app grew — give Node a larger old-space heap. 4 GB fits the default ACR agent.
ENV NODE_OPTIONS=--max-old-space-size=4096
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

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

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
