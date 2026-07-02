# CSA Loom report-accel — DuckDB-over-Delta query accelerator (Direct-Lake-ish).
# Reads lakehouse Delta from ADLS Gen2 via the DuckDB delta + azure extensions,
# authenticating with the Container App's managed identity (credential_chain).
# Internal-ingress only; fronted by LOOM_REPORT_ACCEL_URL. No Fabric / OneLake.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    # DuckDB extensions install to a writable home on first connect.
    HOME=/home/app

# Non-root runtime user.
RUN useradd --create-home --uid 10001 app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Pre-install the duckdb extensions at build time so cold starts don't pay the
# download (and so a locked-down runtime egress can still serve). Best-effort.
RUN python -c "import duckdb; c=duckdb.connect(); c.execute('INSTALL delta; INSTALL azure;')" || true

USER app
EXPOSE 8080

# Uvicorn serves the FastAPI app; the ACA probe hits GET /health.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
