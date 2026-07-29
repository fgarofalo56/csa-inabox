# CSA Loom — DuckDB serving tier image (N2b + N3).
#
# The fast path BELOW Spark: an embedded DuckDB with the azure / httpfs / delta
# / iceberg / postgres / ducklake extensions reading the customer's own ADLS
# Gen2 through the container's user-assigned managed identity. Two wires off ONE
# engine:
#   • HTTP  :8080  — JSON or Arrow IPC stream (what the Loom BFF proxies)
#   • Flight :8815 — Arrow Flight SQL for ADBC / JDBC clients
#
# SOVEREIGN MOAT / IL5: the extensions are INSTALLed during `docker build`, so
# the running container never reaches an extension repository. Combined with
# `autoinstall_known_extensions=false` + `lock_configuration=true` at runtime
# (app/engine.py), the whole capability runs DISCONNECTED in an air-gapped
# enclave against in-boundary storage. No SaaS query service is in the path.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the extensions into the image (build-time network, runtime none).
# `ducklake` + `postgres` are what make the N8 DuckLake catalog real: the tier
# runs `ATTACH 'ducklake:postgres:<dsn>'` against the in-VNet DuckLake Postgres
# store (data-plane/ducklake-catalog-postgres.bicep) and reads the Delta/Parquet
# data in place on ADLS. Without them the ATTACH fails at runtime and the
# catalog surface would be vaporware. Both are core DuckDB extensions from
# duckdb>=1.3 (this image pins 1.5.5 in requirements.txt).
ENV LOOM_DUCKDB_EXT_DIR=/opt/duckdb-extensions
RUN mkdir -p "$LOOM_DUCKDB_EXT_DIR" \
    && python -c "import duckdb, os; \
con = duckdb.connect(); \
con.execute(f\"SET extension_directory = '{os.environ['LOOM_DUCKDB_EXT_DIR']}'\"); \
[con.execute(f'INSTALL {e}') for e in ('httpfs', 'azure', 'delta', 'iceberg', 'postgres', 'ducklake')]; \
print('installed:', con.execute(\"SELECT extension_name, installed FROM duckdb_extensions() WHERE installed\").fetchall())"

COPY app ./app

EXPOSE 8080 8815
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
