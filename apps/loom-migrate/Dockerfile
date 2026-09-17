# CSA Loom — loom-migrate estate-assessment reader image (M1).
#
# The inbound-migration on-ramp's backend: an internal-ingress FastAPI app the
# Console BFF calls to enumerate a source estate (Snowflake / Databricks Unity
# Catalog / Microsoft Fabric / Power BI) into a canonical inventory the console's
# assessment engine turns into a migration-readiness report.
#
# SOVEREIGN MOAT / IL5: the reader runs disconnected in an air-gapped enclave —
# it reaches ONLY the source estate the operator explicitly points it at (with a
# per-request, Key-Vault-resolved bearer). No SaaS assessment service is baked
# in; source REST calls use the Python standard library, so no extension repo or
# third-party HTTP client is contacted at build or run time.
FROM python:3.11-slim

# The leading `dist-upgrade` is the repo-standard SC1 hardening (same as
# apps/fiab-mcp-bridge and apps/loom-transform-runner): it pulls the distro's
# security patches AHEAD of the pinned base tag, which is how OS-layer CRITICALs
# get cleared here without waiting for a base rebuild.
#
# It is NOT prophylactic here (#4547). `python:3.11-slim` resolves to debian
# 13.6, whose `perl-base` 5.40.1-6 carries THREE CRITICALs that Trivy reports as
# `fixed` in 5.40.1-6+deb13u1 — CVE-2026-13221, CVE-2026-42496, CVE-2026-8376.
# Without this line the SC1 gate on the pushed image is RED (`Total: 3
# (CRITICAL: 3)`), which it was on every build run 2026-09-15 → 2026-09-17.
# `perl-base` is a base-layer package no instruction in this file installs, so
# the only lever is the archive upgrade.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
