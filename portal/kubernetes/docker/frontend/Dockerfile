# ─── Stage 1: Build ──────────────────────────────────────────────────────────
# node:20-alpine (pinned 2026-04-17)
FROM node:20-alpine@sha256:f4c96a28c0b2d8981664e03f461c2677152cd9a756012ffa8e2c6727427c2bda AS builder

WORKDIR /app

# Copy package files for dependency caching
COPY portal/react-webapp/package.json portal/react-webapp/package-lock.json* ./

# Install dependencies
RUN npm ci --prefer-offline --no-audit

# Copy source code
COPY portal/react-webapp/ ./

# CSA-0040: Static export controlled by STATIC_EXPORT env var consumed by
# next.config.js (`output: process.env.STATIC_EXPORT === 'true' ? 'export' : undefined`).
# Setting it at build time writes the static bundle to `out/` which nginx serves.
ENV STATIC_EXPORT=true
RUN npm run build

# ─── Stage 2: Serve ─────────────────────────────────────────────────────────
# nginx:1.27-alpine (pinned 2026-04-17)
FROM nginx:1.27-alpine@sha256:0608b4ccda75be0ba50f3cf28998b60d31fe0ad147cd834acb1451ba0da84c8b AS production

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
