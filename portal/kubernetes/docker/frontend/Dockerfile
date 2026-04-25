# ─── Stage 1: Build ──────────────────────────────────────────────────────────
# node:20-alpine (pinned 2026-04-17)
# node:20-alpine multi-arch index (refreshed 2026-04-25)
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Copy package files for dependency caching
# Copy package files for dependency caching
COPY portal/react-webapp/package.json portal/react-webapp/package-lock.json* ./

# Install dependencies
RUN npm ci --prefer-offline --no-audit

# Copy source code
COPY portal/react-webapp/ ./

# Frontend imports types from portal/shared/contracts/types via
# ../../../shared/contracts/types. Inside the container the WORKDIR is
# /app and only portal/react-webapp was copied, so we need to make the
# shared directory available at /shared/contracts/ to match that path.
COPY portal/shared/ /shared/

# CSA-0040: Static export controlled by STATIC_EXPORT env var consumed by
# next.config.js (`output: process.env.STATIC_EXPORT === 'true' ? 'export' : undefined`).
# Setting it at build time writes the static bundle to `out/` which nginx serves.
ENV STATIC_EXPORT=true
RUN npm run build

# ─── Stage 2: Serve ─────────────────────────────────────────────────────────
# nginx:1.27-alpine (pinned 2026-04-17)
# nginx:1.27-alpine multi-arch index (refreshed 2026-04-25; previous pin
# was a single-arch digest which produced 'exec format error' on amd64 runners)
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS production

# Refresh Alpine packages to pull patched libssl/libcrypto/libxml2 etc.
# The base image's apk database is frozen at build time of the pinned
# digest, so even though nginx:1.27-alpine is the latest tag, the bundled
# packages may have unpatched HIGH/CRITICAL CVEs (e.g., CVE-2025-15467,
# CVE-2025-49794, CVE-2026-31789). `apk upgrade` resolves them without
# bumping the nginx major version.
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY portal/kubernetes/docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static files from builder stage. `next build` with
# STATIC_EXPORT=true produces `out/` per next.config.js.
COPY --from=builder /app/out /usr/share/nginx/html

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /usr/share/nginx/html && \
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R appuser:appgroup /var/run/nginx.pid

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
