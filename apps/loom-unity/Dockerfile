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
#   CONSEQUENCE OF STAYING ON v0.5.0, MEASURED (svc-loom-unity-authz round 4):
#   the #1603 bug above is not latent — it fires the moment authorization is
#   enabled. On this pinned image,
#     GET /api/2.1/unity-catalog/permissions/{securable}/{name}
#   returns HTTP 500 "No authorization expression found." while
#   server.authorization=enable, and 200 while it is disabled. PATCH on the same
#   path returns 200 in both states, so grant/revoke works and READS do not.
#   That breaks the Console's Grants pane and the LU-4 effective-permissions
#   resolver (which reads that route for the target and every ancestor) on any
#   catalog running with authorization on. Transcript + control case:
#   docs/fiab/security/loom-unity-authz-proof.md.
#
#   ALSO MEASURED: upstream `AuthDecorator` (v0.5.0 AND v0.5.1) rejects any
#   bearer whose `iss` is not the server's own `internal` issuer, so a Microsoft
#   Entra access token presented directly on /api/2.1/unity-catalog/* is answered
#   403 even with an exact `server.audiences` match. Clients must exchange it at
#   POST /api/1.0/unity-control/auth/tokens first. Bumping to v0.5.1 does NOT
#   change this — it is the upstream design, not a bug.
#
# Build: docker build -t loom-unity .
# Run (local dev, ephemeral H2 file DB). NOTE: since svc-loom-unity-authz,
# LOOM_UNITY_AUTH defaults to `enable` and the entrypoint REFUSES TO BOOT with no
# issuer/audience pinned, so a bare `docker run -p 8080:8080 loom-unity` now exits
# 1 by design. Ask for the open posture explicitly:
#   docker run -p 8080:8080 -e LOOM_UNITY_AUTH=disable loom-unity
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

# ── SC1 supply-chain gate — OS layer ───────────────────────────────────────────
# The pinned base (alpine 3.20.9) scans 2 CRITICALs: libcrypto3 and libssl3 at
# 3.3.6-r0, both cleared by openssl 3.3.7-r0 (CVE-2026-31789, heap buffer
# overflow parsing a large X.509 certificate on 32-bit targets). alpine v3.20's
# package repository already carries 3.3.7-r0, so the base tag is simply behind.
#
# `apk upgrade` is the alpine analogue of the `apt-get dist-upgrade` this repo
# already runs at the top of apps/fiab-mcp-bridge and apps/loom-transform-runner:
# it pulls the distro's security patches AHEAD of the pinned base tag, which is
# how OS-layer CRITICALs get cleared here without waiting for an upstream image
# rebuild. Upgrading the whole package set rather than just openssl is
# deliberate and prophylactic — this is a security-critical service and the next
# base-tag lag should not re-block the gate.
RUN apk upgrade --no-cache \
    && apk info -v libcrypto3 libssl3 | sort -u

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

# ── SC1 supply-chain gate — Java layer ────────────────────────────────────────
# The upstream image bakes its whole sbt/coursier build cache (864 jars, 1.3 GB)
# into the runtime layer, but its launch scripts only ever load the 311 jars
# named by the image's classpath files. One of the 553 leftovers,
# bcprov-jdk18on-1.80.jar, carries CVE-2025-14813 (CRITICAL) — and appears in no
# classpath file, so nothing can load it. scripts/sc1-prune-cache.sh removes
# every cached jar no classpath file references, deriving the keep-set from
# those files themselves and then asserting that every classpath entry survives.
# Full justification and blast-radius analysis live in that script.
#
# It runs AFTER the classpath rewrite above so the assertion also covers the two
# Loom-added jars in lib-loom. It touches no config, no entrypoint, no port and
# no user — the service's auth and network posture are unchanged.
#
# The script lives in a FILE rather than an inline heredoc on purpose: ACR Tasks'
# classic builder cannot parse Dockerfile heredocs (they need BuildKit). A
# heredoc here builds fine under a local `docker build` and then dies in CI after
# ~3s with `failed to run step ID: build: failed to scan dependencies: exit
# status 1`, before any layer runs. Keep this Dockerfile BuildKit-feature-free.
COPY scripts/sc1-prune-cache.sh /tmp/sc1-prune-cache.sh
RUN chmod 0755 /tmp/sc1-prune-cache.sh \
    && /tmp/sc1-prune-cache.sh \
    && rm -f /tmp/sc1-prune-cache.sh

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
