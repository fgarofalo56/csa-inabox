# CSA Loom — loom-unity: self-hosted OSS Unity Catalog server for Azure Government.
#
# Packages the upstream OSS Unity Catalog server (LF AI & Data;
# github.com/unitycatalog/unitycatalog) so Gov clouds — where Databricks Unity
# Catalog is unavailable/limited — get a real Unity Catalog REST backend that
# works day one. This is PACKAGING, not a fork: we start FROM the official
# published image and overlay a thin config-rendering entrypoint.
#
# Base image is PINNED to a released tag (never :latest). The official image is
# published on Docker Hub (unitycatalog/unitycatalog); the v0.5.0 release
# (2026-06-18) is the current server. Bump deliberately with security review.
#
# Build: docker build -t loom-unity .
# Run (local, H2 file DB, auth disabled):
#   docker run -p 8080:8080 loom-unity
# Run (Postgres opt-in):
#   docker run -p 8080:8080 \
#     -e LOOM_UNITY_DB_URL='jdbc:postgresql://host:5432/unitycatalog' \
#     -e LOOM_UNITY_DB_USER=uc -e LOOM_UNITY_DB_PASSWORD=... loom-unity
#
# Azure-native only — no Microsoft Fabric / Power BI dependency. This IS the
# Azure-native Unity Catalog backend (.claude/rules/no-fabric-dependency.md).

FROM unitycatalog/unitycatalog:v0.5.0

# Root only for the overlay; the upstream image already runs as the non-root
# `unitycatalog` service account (restored via USER below).
USER root

# Preserve the image's seeded catalog DB so a fresh Azure Files mount (which
# shadows etc/db) can be seeded with a valid schema on first boot. Best-effort:
# if the image ships no seed db the entrypoint simply starts against an empty dir.
RUN cp -a /home/unitycatalog/etc/db /home/unitycatalog/etc/db.seed 2>/dev/null || true

# Thin config-rendering entrypoint (renders hibernate.properties + server.properties
# from env, seeds the DB dir if empty, then execs the upstream start script).
COPY bin/loom-entrypoint.sh /home/unitycatalog/bin/loom-entrypoint.sh
RUN chmod 0755 /home/unitycatalog/bin/loom-entrypoint.sh \
    && chown -R unitycatalog:unitycatalog /home/unitycatalog/etc /home/unitycatalog/bin/loom-entrypoint.sh 2>/dev/null || true

USER unitycatalog
WORKDIR /home/unitycatalog

# UC server listens on 8080 (documented default).
EXPOSE 8080

ENV LOOM_UNITY_PORT=8080

ENTRYPOINT ["/home/unitycatalog/bin/loom-entrypoint.sh"]

LABEL org.opencontainers.image.title="Loom Unity (OSS Unity Catalog for Azure Government)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="loom-unity"
LABEL csa.loom.version="0.1.0"
LABEL csa.loom.upstream="unitycatalog/unitycatalog:v0.5.0"
