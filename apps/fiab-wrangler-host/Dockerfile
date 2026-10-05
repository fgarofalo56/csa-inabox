# CSA Loom — Data Wrangler pandas host image.
#
# A small FastAPI/pandas service that backs the notebook editor's Data Wrangler
# panel (Fabric "Data Wrangler" 1:1 on Azure). It executes a FIXED gallery of
# structured transform steps on a DATA SAMPLE the Console posts, returns the
# resulting preview grid + per-column summary, and generates the equivalent
# pandas AND PySpark code for export-to-cell. It runs NO arbitrary user code
# (the operation gallery is a closed set) and touches NO Azure data plane — the
# sample is sent in the request and the result returned in the response, so the
# assigned identity only ever needs AcrPull.
FROM python:3.11-slim

# SC1 hardening (#4561): python:3.11-slim's debian-13 base carries `perl-base`
# 5.40.1-6 with three CRITICAL CVEs (CVE-2026-13221, CVE-2026-42496,
# CVE-2026-8376), fixed in 5.40.1-6+deb13u1. perl-base is inherited from the
# base layer -- this file installs nothing via apt, so unlike its siblings
# (apps/loom-migrate/Dockerfile) there was no existing apt-get block to merge
# the fix into. This is therefore a new minimal layer rather than a merge: the
# same repo-standard dist-upgrade line, with no package installed.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user (defense-in-depth; the container is the boundary).
RUN useradd --create-home --uid 10001 wrangler

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

USER wrangler
EXPOSE 8080
ENV PORT=8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
