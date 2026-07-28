# CSA Loom — transform runner image (N4).
#
# ONE runtime, TWO transformation engines:
#   • dbt-core (+ dbt-synapse / dbt-databricks / dbt-duckdb / opt-in dbt-fabric)
#     — the ecosystem default, unchanged from the existing loom-dbt-runner.
#   • SQLMesh — virtual data environments, Terraform-style plan/apply, and
#     column-level model diffs.
#
# Microsoft ODBC Driver 18 for SQL Server is required by dbt-synapse /
# dbt-fabric and by SQLMesh's mssql engine adapter. Authentication to every
# backend is the container's USER-ASSIGNED MANAGED IDENTITY (AZURE_CLIENT_ID is
# injected by bicep) — no passwords, no storage keys, no secrets in app
# settings.
#
# SOVEREIGN MOAT: this is OSS Python running on Azure Container Apps inside the
# deployment's own VNet. It has no SaaS control plane (no dbt Cloud, no Tobiko
# Cloud), so the full plan/apply/diff capability runs DISCONNECTED in an IL5
# air-gapped enclave against in-boundary Synapse / Databricks / DuckDB-on-ADLS.
FROM python:3.11-slim

# Microsoft ODBC Driver 18 for SQL Server (dbt-synapse / dbt-fabric / SQLMesh mssql).
#
# The leading `dist-upgrade` is the repo-standard SC1 hardening (same as
# apps/fiab-mcp-bridge/Dockerfile): it pulls the distro's security patches
# AHEAD of the pinned base tag, which is how OS-layer CRITICALs get cleared here
# without waiting for a base rebuild. The debian 13.6 layer of this image scans
# 0 CRITICAL today — this is prophylactic, so the next base-tag lag doesn't
# re-block the gate.
RUN apt-get update && apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends curl gnupg2 apt-transport-https ca-certificates unixodbc-dev gcc g++ git \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-security.txt ./
COPY scripts ./scripts

# Two passes on purpose. requirements.txt is the resolvable pin set;
# requirements-security.txt then OVERRIDES transitive pins that would otherwise
# ship a CRITICAL CVE (today: deepdiff 7.0.1 / CVE-2025-58367, held back by
# dbt-common 1.27.1, which is itself held by dbt-core's protobuf<6 fence). See
# that file for the full justification and the removal plan.
#
# The override deliberately conflicts with a declared range, so pip emits a
# "dependency conflicts" advisory and still exits 0 — which means a typo would
# fail SILENTLY. scripts/assert_security_pins.py turns that back into a build
# failure.
#
# That assertion lives in a FILE, not an inline heredoc: ACR Tasks' classic
# builder does not support Dockerfile heredocs (they require BuildKit). A
# heredoc here builds fine under a local `docker build` and then dies in CI with
# `failed to run step ID: build: failed to scan dependencies: exit status 1`
# after ~3s, before any layer runs — an opaque message that names neither the
# heredoc nor the parser. Keep this Dockerfile BuildKit-feature-free.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -r requirements-security.txt \
    && python scripts/assert_security_pins.py

COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
