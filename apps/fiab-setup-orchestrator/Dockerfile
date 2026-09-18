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
# security patches AHEAD of the pinned base tag.
#
# It is NOT prophylactic here (#4547). What is ESTABLISHED, measured 2026-09-17:
# `python:3.12-slim` resolved that day to debian 13.6, whose `perl-base`
# 5.40.1-6 carries THREE CRITICALs Trivy reports as `fixed` in
# 5.40.1-6+deb13u1 — CVE-2026-13221, CVE-2026-42496, CVE-2026-8376. Without
# this line the SC1 gate on the pushed image was RED (`Total: 3 (CRITICAL: 3)`)
# on every build run 2026-09-15 → 2026-09-17; with it, the archive upgrade
# clears all three AT THAT BASE SNAPSHOT (13.6 → 13.7, target row present at 0).
# loom-migrate carries the identical three findings from the identical base
# layer and is fixed the same way.
#
# What is NOT established, deliberately left open: whether "debian 13" or "this
# dated base snapshot" is the discriminator. As of 2026-09-17 every debian-13
# base observable (debian:trixie-slim, python:3.11-slim, python:3.12-slim) is
# 13.6 with the same vulnerable `perl-base`, so the two readings are
# observationally identical and this comment does not pick one. Do not read it
# as "debian 13 is inherently red".
#
# `perl-base` is a base-layer package no instruction in this file installs, so
# it cannot be fixed by an `apt-get install` here. THREE levers exist, and an
# earlier version of this comment named only one of them:
#   1. this archive upgrade — chosen, because it is in-repo and immediate;
#   2. moving to a `-bookworm` base tag — ALSO available to this repo and
#      already exercised elsewhere (platform/runners/script-runner is on
#      `python:3.12-slim-bookworm`; fiab-mcp-bridge's `node:22-bookworm-slim`
#      scans debian 12.15 at 0). Not chosen here: it changes the Python/OS
#      pairing for a CVE fix, which is a larger blast radius than one RUN line.
#   3. an upstream base rebuild — not available to this repo, and this line
#      exists so we do not wait for it.
# An earlier revision said the archive upgrade was "the only lever available to
# this repo". That was false; lever 2 is ours. Recorded rather than edited away,
# because the sentence was introduced BY a review round asking for more
# precision — a narrowing that produced a more precise falsehood.
# If a republished base ships the fix, this line becomes a no-op rather than
# wrong, and the OS-version claim above should be re-measured before being
# quoted again.
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
