# Multi-stage build for the hosted-agent container.
# Same image works for `docker run` locally, ACA, AKS, or Foundry Agent Service.

FROM mcr.microsoft.com/azurelinux/base/python:3.12 AS base

WORKDIR /app

# System deps — keep slim
RUN tdnf update -y && tdnf install -y ca-certificates && tdnf clean all

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# App
COPY hosted-agent/ ./hosted-agent/
COPY data-analyst-agent/ ./data-analyst-agent/

# Non-root user
RUN useradd -u 10001 -m agent && chown -R agent:agent /app
USER 10001

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

EXPOSE 8000

# Health endpoints used by the ACA probes in main.bicep
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health').read()" || exit 1

ENTRYPOINT ["uvicorn", "hosted-agent.server:app", "--host", "0.0.0.0", "--port", "8000"]
