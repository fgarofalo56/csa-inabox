# ─── Stage 1: Dependencies ───────────────────────────────────────────────────
# python:3.12-slim (pinned 2026-04-17)
# python:3.12-slim multi-arch index (refreshed 2026-04-25 to clear stale CVEs
# in libexpat1, krb5, sqlite, openssl, etc.)
FROM python:3.12-slim@sha256:46cb7cc2877e60fbd5e21a9ae6115c30ace7a077b9f8772da879e4590c18c2e3 AS builder

WORKDIR /app

# Install build dependencies
# `dist-upgrade` pulls the distro's security patches ahead of the pinned base
# digest — the loom-onelake / fiab-mcp-bridge pattern. The digest below is from
# 2026-04-25; without this line the image ships that day's openssl, libcap2 and
# liblzma5, which is where most of this image's Trivy findings came from.
RUN apt-get update && apt-get dist-upgrade -y && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY portal/shared/requirements.txt ./requirements.txt

# Pin pip >= 26.0 to clear CVE-2025-8869 + CVE-2026-1703 in the base image's pip 25.0.1.
# setuptools ships in the base image at 70.3.0; CVE-2025-47273 (HIGH, path
# traversal in PackageIndex) is fixed in 78.1.1.
RUN pip install --no-cache-dir --upgrade 'pip>=26.0' 'setuptools>=78.1.1'

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
# python:3.12-slim (pinned 2026-04-17)
FROM python:3.12-slim@sha256:46cb7cc2877e60fbd5e21a9ae6115c30ace7a077b9f8772da879e4590c18c2e3 AS production

WORKDIR /app

# Runtime stage needs the SAME distro security patches. It has no apt layer of
# its own, so without this it ships the pinned digest's OS packages untouched
# even though the builder was patched — /install carries Python packages only.
RUN apt-get update && apt-get dist-upgrade -y && rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Upgrade pip + setuptools in the runtime stage too. Stage 1 upgrades them in
# the *builder's* /usr/local, but the only thing we copy into the runtime image
# is /install (the requirements, not pip/setuptools themselves). Without this
# the runtime image still ships the base image's pip 25.0.1 (CVE-2026-6357) and
# setuptools 70.3.0 (CVE-2025-47273).
#
# ORDER MATTERS: this runs AFTER the COPY above, not before. `/install` carries
# no setuptools today (verified by a `pip install --dry-run --report` resolve of
# requirements.txt), but if a future requirement pulled one in, a COPY landing
# after this line would silently overwrite the patched version and reintroduce
# the CVE with no signal.
RUN pip install --no-cache-dir --upgrade 'pip>=26.1' 'setuptools>=78.1.1'

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

# Set Python path so portal.shared.api.main is importable
ENV PYTHONPATH=/app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "portal.shared.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4", "--access-log"]
