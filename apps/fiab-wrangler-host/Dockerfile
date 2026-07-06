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
