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

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
