# Loom Setup Orchestrator — FastAPI + 2-tier orchestrator backend
#
# Service: csa-loom-setup-orchestrator
# Image:   loom/setup-orchestrator:v0.1
# Port:    8000
# Health:  GET /health

FROM python:3.12-slim AS base

# Build-time tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
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
