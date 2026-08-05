# CSA Loom — dbt runner image.
# dbt-core + dbt-synapse + dbt-fabric + Microsoft ODBC Driver 18 for SQL Server.
# Authenticates to Synapse/Fabric with the container's managed identity via the
# ODBC ActiveDirectory/CLI path (no secrets baked in).
FROM python:3.11-slim

# Microsoft ODBC Driver 18 for SQL Server (required by dbt-synapse / dbt-fabric).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg2 apt-transport-https ca-certificates unixodbc-dev gcc g++ \
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
# that file for the full justification and the removal plan. This is the same
# shape apps/loom-transform-runner already uses for the identical finding —
# that sibling adopted the fix, this app did not, and the SC1 Trivy gate has
# failed `Build loom-dbt-runner` on every full-app-deploy-commercial run since.
#
# The override deliberately conflicts with a declared range, so pip emits a
# "dependency conflicts" advisory and still exits 0 — which means a typo would
# fail SILENTLY. scripts/assert_security_pins.py turns that back into a build
# failure.
#
# That assertion lives in a FILE, not an inline heredoc: ACR Tasks' classic
# builder does not support Dockerfile heredocs (they require BuildKit). Keep
# this Dockerfile BuildKit-feature-free.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -r requirements-security.txt \
    && python scripts/assert_security_pins.py
COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
