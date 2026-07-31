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
# setuptools ships in the base image at 70.3.0. Two advisories apply and they
# have DIFFERENT fix versions: CVE-2025-47273 (HIGH, path traversal in
# PackageIndex) is fixed in 78.1.1, CVE-2026-59890 (MEDIUM) not until 83.0.0.
# The floor is the HIGHER of the two. A >=78.1.1 floor resolved to 83.0.0 in
# practice only because pip takes the newest match — it would have silently
# reintroduced CVE-2026-59890 the moment anything pinned 78.1.1 exactly.
RUN pip install --no-cache-dir --upgrade 'pip>=26.0' 'setuptools>=83.0.0'

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
#
# `ca-certificates` is installed explicitly rather than relied on from the base
# image: this service fetches Entra JWKS and calls Azure Key Vault / Storage over
# TLS, so a stale CA bundle is a real failure mode, not decoration. It also keeps
# `update` and an `install` in the SAME layer, which is what Trivy DS-0017 asks
# for — the first version of this line was update + dist-upgrade with no install
# and tripped that rule.
RUN apt-get update && apt-get dist-upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# The runtime image needs NO installer: it only runs uvicorn. Removing pip and
# setuptools here (after the COPY, so nothing reinstalls them) does two things:
#
# 1. Clears the three findings that NO version bump can fix: pip's own
#    `pip/_vendor/vendor.txt` declares vendored copies of msgpack 1.1.2 and
#    setuptools 70.3.0, and Trivy parses that file as a package manifest (the
#    aggregate "Python" target). Those pins live inside pip 26.2 — the NEWEST
#    pip — so upgrading can never clear them; only removing pip does. Verified
#    by building this image and finding the flagged versions nowhere on disk
#    except vendor.txt, while the real site-packages carried setuptools 83.0.0
#    and msgpack 1.2.1.
# 2. Ships no package manager in the production image, so a compromised
#    container cannot pip-install tooling.
#
# The builder stage keeps pip + a patched setuptools; only the runtime sheds them.
RUN python -m pip uninstall -y pip setuptools

# Copy the shared API application AND the csa_platform package it imports.
# csa_platform was NEVER copied in: every build since this Dockerfile existed
# produced an image whose entrypoint dies on
#   ModuleNotFoundError: No module named 'csa_platform'
# (portal/shared/api/main.py line 36 imports csa_platform.governance.common.
# logging before the app object is even constructed). It built green and passed
# Trivy because nothing ever imported the app inside the image. The whole
# package is copied (7.4MB of source); only the submodules portal/shared
# actually imports (common, governance.common, ai_integration.rag) have their
# dependencies installed — Python resolves imports lazily, so the heavy
# geo/pandas subtrees stay dormant and their deps are deliberately NOT added.
COPY csa_platform/ ./csa_platform/
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
