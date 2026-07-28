# CSA Loom — loom-unity: self-hosted OSS Unity Catalog server for Azure Government.
#
# Packages the upstream OSS Unity Catalog server (LF AI & Data;
# github.com/unitycatalog/unitycatalog) so Gov clouds — where Databricks Unity
# Catalog is unavailable/limited — get a real Unity Catalog REST backend that
# works day one. This is PACKAGING, not a fork: we start FROM the official
# published image and overlay a thin config-rendering entrypoint plus the two
# jars needed for Entra-only PostgreSQL persistence (LU-1).
#
# Base image is PINNED to a released tag (never :latest). The official image is
# published on Docker Hub (unitycatalog/unitycatalog).
#
# IMAGE-TAG PIN — re-verified 2026-07-28 (LU-1), pin UNCHANGED at v0.5.0:
#   Upstream cut GitHub release v0.5.1 on 2026-07-18 (credential-cache scoping in
#   unitycatalog-hadoop, plus a fix for the permission GET routes returning HTTP
#   500 when server-side authorization is ENABLED — directly relevant to LU-2).
#   BUT the Docker Hub repository publishes no such image:
#     GET https://hub.docker.com/v2/repositories/unitycatalog/unitycatalog/tags/v0.5.1
#       -> 404 {"message":"httperror 404: tag 'v0.5.1' not found"}
#     Released tags actually published there: v0.5.0, v0.4.0, v0.3.1, v0.3.0,
#     v0.2.1 (plus `latest` and main-<sha> dev tags); v0.5.0 last pushed 2026-07-03.
#   There is therefore nothing to bump TO. The pin stays at v0.5.0 rather than
#   moving to `latest` (unpinned) or rebuilding the server from source (that
#   would end "packaging, not a fork"). Re-check when upstream publishes the
#   image — the permissions-GET-with-authorization fix is the reason to move
#   promptly once it exists.
#   Note also (carried from LU-2): `server.access-token-timeout` exists on
#   upstream main but NOT in v0.5.0/v0.5.1, so the entrypoint does not render it.
#
# Build: docker build -t loom-unity .
# Run (local, ephemeral H2 file DB, auth disabled — dev only):
#   docker run -p 8080:8080 loom-unity
# Run (the LU-1 default posture — Entra-only Postgres, no password anywhere):
#   docker run -p 8080:8080 \
#     -e LOOM_UNITY_DB_URL='jdbc:postgresql://psql-loom-unity-x.postgres.database.usgovcloudapi.net:5432/unitycatalog' \
#     -e LOOM_UNITY_DB_USER=uami-loom-unity \
#     -e LOOM_UNITY_DB_AUTH=entra \
#     -e LOOM_UNITY_DB_AAD_RESOURCE='https://ossrdbms-aad.database.usgovcloudapi.net' \
#     -e AZURE_CLIENT_ID=<uami-client-id> loom-unity
#
# Azure-native only — no Microsoft Fabric / Power BI dependency. This IS the
# Azure-native Unity Catalog backend (.claude/rules/no-fabric-dependency.md).

# ---------------------------------------------------------------------------
# Stage 1 — PostgreSQL JDBC driver + the Loom Unity Entra authentication plugin.
#
# LU-1: the catalog now lives on an Azure Database for PostgreSQL Flexible Server
# created with passwordAuth=Disabled, so the server needs (a) a Postgres JDBC
# driver — upstream v0.5.0's build.sbt ships only H2 — and (b) something that
# mints a fresh Microsoft Entra token for EVERY physical connection, because a
# token rendered once into hibernate.properties expires within the hour and the
# catalog would then hard-fail authentication long after it looked healthy.
#
# pgjdbc's `authenticationPluginClassName` hook is exactly that seam (the same
# one Microsoft's azure-identity-extensions plugin uses). We compile a single
# dependency-free class against it rather than pulling azure-identity + msal4j +
# reactor + netty + jackson onto the classpath of a netty/jackson application —
# full rationale in the .java source header.
# ---------------------------------------------------------------------------
FROM amazoncorretto:17-alpine3.20-jdk AS jdbcplugin

# Pin the driver AND its checksum. The digest below was verified by downloading
# the artifact from Maven Central on 2026-07-28 and hashing it locally; a
# tampered or truncated download fails the build instead of shipping.
ARG PG_JDBC_VERSION=42.7.7
ARG PG_JDBC_SHA256=157963d60ae66d607e09466e8c0cdf8087e9cb20d0159899ffca96bca2528460

RUN apk add --no-cache curl ca-certificates

WORKDIR /build
RUN curl -fsSL -o /build/postgresql.jar \
      "https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_JDBC_VERSION}/postgresql-${PG_JDBC_VERSION}.jar" \
 && echo "${PG_JDBC_SHA256}  /build/postgresql.jar" | sha256sum -c -

COPY java/ /build/src/
RUN mkdir -p /build/classes /build/lib \
 && javac -Xlint:all -cp /build/postgresql.jar -d /build/classes \
      $(find /build/src -name '*.java') \
 && jar --create --file /build/loom-unity-entra-auth.jar -C /build/classes . \
 && cp /build/postgresql.jar /build/loom-unity-entra-auth.jar /build/lib/

# ---------------------------------------------------------------------------
# Stage 2 — the Loom Unity image.
# ---------------------------------------------------------------------------
FROM unitycatalog/unitycatalog:v0.5.0

# Root only for the overlay; the upstream image already runs as the non-root
# `unitycatalog` service account (restored via USER below).
USER root

# Preserve the image's seeded catalog DB so a fresh Azure Files mount (which
# shadows etc/db) can be seeded with a valid schema on first boot. Best-effort:
# if the image ships no seed db the entrypoint simply starts against an empty dir.
# Only relevant to the legacy H2 fallback — Postgres owns its own schema.
RUN cp -a /home/unitycatalog/etc/db /home/unitycatalog/etc/db.seed 2>/dev/null || true

# Postgres driver + Entra auth plugin, appended to the server classpath.
#
# The upstream start script runs `java -cp $(cat <classpath-file>)`, where the
# classpath file is a single line written by sbt under server/target. We rewrite
# that file IN PLACE (not `mv`) so its ownership and mode survive, and use
# `$(cat ...)` so a trailing newline is stripped — a newline inside the -cp
# argument would word-split the java command and break the boot.
#
# The build FAILS LOUDLY if the classpath file is missing or the rewrite does not
# take: silently shipping an image whose Postgres driver is not on the classpath
# would be a catalog that quietly boots on H2 while the deployment claims Postgres.
COPY --from=jdbcplugin /build/lib/ /home/unitycatalog/lib-loom/
RUN set -eu; \
    CP_FILE="$(find /home/unitycatalog -type f -name classpath -path '*server/target*' | head -n 1)"; \
    if [ -z "${CP_FILE}" ]; then \
      echo "FATAL: upstream classpath file not found under /home/unitycatalog/server/target — cannot install the Postgres driver" >&2; \
      exit 1; \
    fi; \
    EXTRA="$(find /home/unitycatalog/lib-loom -name '*.jar' | sort | tr '\n' ':' | sed 's/:$//')"; \
    printf '%s:%s' "$(cat "${CP_FILE}")" "${EXTRA}" > /tmp/loom-classpath; \
    cat /tmp/loom-classpath > "${CP_FILE}"; \
    rm -f /tmp/loom-classpath; \
    chmod 0555 /home/unitycatalog/lib-loom; \
    chmod 0444 /home/unitycatalog/lib-loom/*.jar; \
    chown -R unitycatalog:unitycatalog /home/unitycatalog/lib-loom; \
    grep -q 'loom-unity-entra-auth.jar' "${CP_FILE}" || { echo "FATAL: classpath rewrite did not take" >&2; exit 1; }

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

LABEL org.opencontainers.image.title="Loom Unity (Unity-Catalog-compatible metastore for Azure Government)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="loom-unity"
LABEL csa.loom.version="0.2.0"
LABEL csa.loom.upstream="unitycatalog/unitycatalog:v0.5.0"
