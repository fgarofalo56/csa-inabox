# ─── Stage 1: Dependencies ───────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY portal/shared/requirements.txt ./requirements.txt

# If requirements.txt doesn't exist yet, install core deps directly
RUN if [ -f requirements.txt ] && [ -s requirements.txt ]; then \
        pip install --no-cache-dir --prefix=/install -r requirements.txt; \
    else \
        pip install --no-cache-dir --prefix=/install \
            fastapi==0.115.* \
            uvicorn[standard]==0.34.* \
            pydantic==2.* \
            pydantic-settings==2.* \
            httpx==0.28.* \
            python-multipart==0.0.* \
            redis==5.* \
            azure-identity==1.* \
            azure-keyvault-secrets==4.*; \
    fi

# ─── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM python:3.12-slim AS production

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy the shared API application
COPY portal/shared/ ./portal/shared/

# Create non-root user
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/false appuser && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1

# Set Python path so portal.shared.api.app is importable
ENV PYTHONPATH=/app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "portal.shared.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4", "--access-log"]
