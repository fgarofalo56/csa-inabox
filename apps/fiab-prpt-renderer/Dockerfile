FROM python:3.12-slim

# SC1 hardening (#4561): python:3.12-slim's debian-13 base carries `perl-base`
# 5.40.1-6 with three CRITICAL CVEs (CVE-2026-13221, CVE-2026-42496,
# CVE-2026-8376), fixed in 5.40.1-6+deb13u1. This file had no apt-get layer to
# merge the fix into (it installs nothing via apt), so this is a new minimal
# layer -- the same repo-standard dist-upgrade line as
# apps/loom-migrate/Dockerfile, with no package installed. This image has no
# deploy producer yet (scripts/ci/check-image-producer-coverage.mjs
# KNOWN_UNBUILT), so it is never SC1-gated; the fix is applied anyway for
# consistency per #4561.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY renderer_core.py app.py ./

EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "120", "app:app"]
