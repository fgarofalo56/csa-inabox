# Loom Setup Orchestrator — FastAPI + 2-tier orchestrator backend
#
# Service: csa-loom-setup-orchestrator
# Image:   loom/setup-orchestrator:v0.1
# Port:    8000
# Health:  GET /health

FROM python:3.12-slim AS base

# Build-time tooling.
#
# The leading `dist-upgrade` is the repo-standard SC1 hardening (same as
# apps/fiab-mcp-bridge and apps/loom-transform-runner): it pulls the distro's
# security patches AHEAD of the pinned base tag, which is how OS-layer CRITICALs
# get cleared here without waiting for a base rebuild.
#
# It is NOT prophylactic here (#4547). `python:3.12-slim` resolves to debian
# 13.6, whose `perl-base` 5.40.1-6 carries THREE CRITICALs that Trivy reports as
# `fixed` in 5.40.1-6+deb13u1 — CVE-2026-13221, CVE-2026-42496, CVE-2026-8376.
# Without this line the SC1 gate on the pushed image is RED (`Total: 3
# (CRITICAL: 3)`), which it was on every build run 2026-09-15 → 2026-09-17.
# `perl-base` is a base-layer package no instruction in this file installs, so
# the only lever is the archive upgrade. loom-migrate carries the identical
# three findings from the identical base layer and is fixed the same way.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY pyproject.toml ./

# Install Python deps. We don't use pip-tools here; let pip resolve.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir .

# Copy source
COPY src/ ./src/

# Non-root user
RUN useradd --create-home --uid 10001 loom && \
    chown -R loom:loom /app
USER loom

ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["uvicorn", "loom_setup_orchestrator.main:app", "--host", "0.0.0.0", "--port", "8000"]

LABEL csa.loom.component="setup-orchestrator"
LABEL csa.loom.version="0.1.0"
