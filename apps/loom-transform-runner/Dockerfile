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
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg2 apt-transport-https ca-certificates unixodbc-dev gcc g++ git \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
