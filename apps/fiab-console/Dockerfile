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
RUN npm install -g pnpm@9 && \
    pnpm build

# ============================================================
# Stage 3 — runner (production)
# ============================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

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
