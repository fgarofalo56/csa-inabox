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
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
