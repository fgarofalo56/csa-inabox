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
# IMAGE-TAG PIN — re-verified 2026-08-04. Base image PINNED at v0.5.0; the #1603
# permission-GET fix is applied by OVERLAYING the upstream v0.5.1 unitycatalog-
# server ARTIFACT (see stage 2, lib-loom-override) — NOT by bumping the base tag:
#   Upstream cut GitHub release v0.5.1 on 2026-07-18 (credential-cache scoping in
#   unitycatalog-hadoop, plus a fix for the permission GET routes returning HTTP
#   500 when server-side authorization is ENABLED — issue #1603).
#   The Docker Hub IMAGE for v0.5.1 was never published:
#     GET https://hub.docker.com/v2/repositories/unitycatalog/unitycatalog/tags/v0.5.1
#       -> 404 {"message":"httperror 404: tag 'v0.5.1' not found"}
#     (v0.5.0 is still the newest published tag.) The earlier note "there is
#     therefore nothing to bump TO" checked ONLY Docker Hub and was incomplete:
#   the v0.5.1 SERVER MODULE *is* published on Maven Central —
#     io.unitycatalog:unitycatalog-server:0.5.1  (upstream's own released binary).
#   That is the same "packaging, not a fork" seam this image already uses for the
#   Postgres JDBC driver, so stage 2 OVERLAYS it instead of forking or rebuilding
#   from source. The published jar is THIN — only `io.unitycatalog.*` classes plus
#   the `jcasbin_auth_model.conf` authorization-model resource, no shaded third-
#   party packages — and it BUNDLES the server + control model classes. Prepended
#   to the server classpath (ahead of the v0.5.0 `server/target/classes`), its
#   classes WIN the first-match scan, so the whole UC server module — the fixed
#   PermissionService + UnityAccessDecorator + JCasbinAuthorizer, the bundled
#   models, and the auth-model resource — runs at v0.5.1 as a self-consistent set,
#   while every THIRD-PARTY dependency stays exactly as the pinned base ships it.
#   The v0.5.0 and v0.5.1 server POMs are byte-identical except their own version
#   strings (ZERO third-party dependency changes — verified 2026-08-04), so the
#   v0.5.1 classes link cleanly against the base image's v0.5.0 dependency jars.
#   Building the server from source is still NOT done here (that would end
#   "packaging, not a fork") — this consumes upstream's released artifact verbatim.
#   Note also (carried from LU-2): `server.access-token-timeout` exists on
#   upstream main but NOT in v0.5.0/v0.5.1, so the entrypoint does not render it.
#
#   MEASURED, on the BARE v0.5.0 image before the overlay (svc-loom-unity-authz
#   round 4): the #1603 bug is not latent — it fires the moment authorization is
#   enabled.
#     GET /api/2.1/unity-catalog/permissions/{securable}/{name}
#   returned HTTP 500 "No authorization expression found." while
#   server.authorization=enable, and 200 while disabled (PATCH 200 in both). That
#   broke the Console's Grants pane and the LU-4 effective-permissions resolver.
#   WITH the v0.5.1 server overlay that GET returns 200 with authorization enabled
#   — apps/loom-unity/tests/authz/authz-e2e.sh case 9 (now expects 200). Transcript
#   + control cases: docs/fiab/security/loom-unity-authz-proof.md.
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

# ── #1603 overlay — upstream v0.5.1 unitycatalog-server (permission-GET fix) ────
# The permission GET routes 500 under server.authorization=enable on v0.5.0
# (issue #1603). Docker Hub never published the v0.5.1 IMAGE, but Maven Central
# publishes the v0.5.1 SERVER MODULE — io.unitycatalog:unitycatalog-server:0.5.1,
# upstream's own released binary. Stage 2 PREPENDS this thin jar to the server
# classpath so its (fixed) classes shadow the v0.5.0 base copies; see the header
# rationale for why this is packaging, not a fork.
#
# Pin the artifact AND its SHA-256. The digest below was verified by downloading
# the jar from Maven Central on 2026-08-04 and hashing it locally — it matched
# both the value hashed locally and the published `.jar.sha256` sidecar. A
# tampered or truncated download fails the build instead of shipping the bug back.
ARG UC_SERVER_VERSION=0.5.1
ARG UC_SERVER_SHA256=df8647d5a0e2b72c623fff5c2cf6f08a739a33e34aea960dfbd862495ef3b027
RUN mkdir -p /build/override \
 && curl -fsSL -o /build/override/unitycatalog-server.jar \
      "https://repo1.maven.org/maven2/io/unitycatalog/unitycatalog-server/${UC_SERVER_VERSION}/unitycatalog-server-${UC_SERVER_VERSION}.jar" \
 && echo "${UC_SERVER_SHA256}  /build/override/unitycatalog-server.jar" | sha256sum -c -

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
#
# `curl` is added in the same layer because the entrypoint's AUTO-BIND step
# (bind_console_principal — registers the Console principal as an ENABLED Unity
# Catalog user so authorization can be enforced without bricking the catalog)
# talks to 127.0.0.1 over HTTP. It is not assumed to be present in the upstream
# base: an auto-bind that silently no-ops because a tool is missing would leave
# the catalog refusing its own Console with no obvious cause.
#
# RETRY, and why it is NOT `--force-missing-repositories` ───────────────────────
# On 2026-08-05 this layer failed the build at main de3ad20f (run 30976360448,
# ACR task cj2tq) with:
#   WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.20/main:
#            temporary error (try again later)
#   ERROR: Not continuing due to stale/unavailable repositories.
#          Use --force-missing-repositories to continue.
# That was a TRANSIENT dl-cdn blip, not a stale pin — proven three ways:
#   (1) in the SAME failing build, step 4 fetched that EXACT index 74 s earlier
#       (05:01:41) and succeeded;
#   (2) this image built green at 02:12, 03:34, 04:33 and again at 05:50 (run
#       30979142799) on a byte-identical layer, with no code change;
#   (3) both v3.20 indexes served HTTP 200 on demand.
# apk prints "stale/unavailable repositories" for ANY repo whose index fetch
# failed, so the wording misleads; the preceding "temporary error (try again
# later)" is apk's phrasing for a failed HTTP fetch.
#
# `--force-missing-repositories` would be exactly the WRONG fix here: it would
# build the image against whatever repos happened to answer, silently DROPPING
# `main` — the repo that carries the openssl 3.3.7-r0 upgrade this very layer
# exists to apply. A security-critical, federal-facing service would then ship
# with an unknown package set and a silently un-patched CRITICAL. So instead we
# retry the fetch, unchanged and still pinned, and FAIL HARD if the CDN is
# genuinely unreachable — a real outage still stops the build, loudly.
RUN set -eu; \
    ok=0; \
    for attempt in 1 2 3 4 5; do \
      if apk upgrade --no-cache && apk add --no-cache curl; then ok=1; break; fi; \
      echo "loom-unity: apk attempt ${attempt}/5 failed (transient index fetch?) - retrying in $((attempt * 5))s"; \
      sleep "$((attempt * 5))"; \
    done; \
    [ "$ok" -eq 1 ] || { echo "ERROR: apk upgrade/add failed 5 consecutive times - refusing to build a security-critical image against an unverified package set"; exit 1; }; \
    command -v curl >/dev/null || { echo "ERROR: curl absent after apk add - the entrypoint AUTO-BIND step would silently no-op"; exit 1; }; \
    apk info -v libcrypto3 libssl3 | sort -u

# Preserve the image's seeded catalog DB so a fresh Azure Files mount (which
# shadows etc/db) can be seeded with a valid schema on first boot. Best-effort:
# if the image ships no seed db the entrypoint simply starts against an empty dir.
# Only relevant to the legacy H2 fallback — Postgres owns its own schema.
RUN cp -a /home/unitycatalog/etc/db /home/unitycatalog/etc/db.seed 2>/dev/null || true

# Server classpath overlay + Loom jars.
#
# The upstream start script runs `java -cp $(cat <classpath-file>)`, where the
# classpath file is a single colon-separated line written by sbt under
# server/target — and it includes `server/target/classes`, the image's own
# compiled v0.5.0 server classes. Java resolves a class from the FIRST classpath
# entry that contains it, so ORDER decides which copy wins. We rewrite the file
# IN PLACE (not `mv`) so its ownership and mode survive, and use `$(cat ...)` so a
# trailing newline is stripped — a newline inside the -cp argument would
# word-split the java command and break the boot.
#
#   PREPEND  lib-loom-override/unitycatalog-server.jar (upstream v0.5.1) — placed
#            BEFORE the v0.5.0 server/target/classes so the #1603-fixed classes
#            (PermissionService, UnityAccessDecorator, …) win the first-match
#            scan. This is the whole point of the overlay. The v0.5.0 classes stay
#            on the path as a fallback for anything the jar does not carry — the
#            jar only ADDS/SHADOWS, never removes, so there is no not-found risk.
#   APPEND   lib-loom/* (Postgres driver + Entra auth plugin) — purely additive,
#            unique classes, so their position does not matter.
#
# The build FAILS LOUDLY if the classpath file is missing, the Postgres/Entra
# rewrite does not take, or the v0.5.1 override is not FIRST on the path — a
# shadowed override would silently ship the v0.5.0 500-on-permission-GET bug while
# claiming to fix it, which is exactly the failure this assertion exists to catch.
COPY --from=jdbcplugin /build/lib/ /home/unitycatalog/lib-loom/
COPY --from=jdbcplugin /build/override/ /home/unitycatalog/lib-loom-override/
RUN set -eu; \
    CP_FILE="$(find /home/unitycatalog -type f -name classpath -path '*server/target*' | head -n 1)"; \
    if [ -z "${CP_FILE}" ]; then \
      echo "FATAL: upstream classpath file not found under /home/unitycatalog/server/target — cannot install the #1603 server override or the Postgres driver" >&2; \
      exit 1; \
    fi; \
    OVERRIDE="$(find /home/unitycatalog/lib-loom-override -name '*.jar' | sort | tr '\n' ':' | sed 's/:$//')"; \
    EXTRA="$(find /home/unitycatalog/lib-loom -name '*.jar' | sort | tr '\n' ':' | sed 's/:$//')"; \
    if [ -z "${OVERRIDE}" ]; then echo "FATAL: v0.5.1 unitycatalog-server override jar not found in lib-loom-override" >&2; exit 1; fi; \
    printf '%s:%s:%s' "${OVERRIDE}" "$(cat "${CP_FILE}")" "${EXTRA}" > /tmp/loom-classpath; \
    cat /tmp/loom-classpath > "${CP_FILE}"; \
    rm -f /tmp/loom-classpath; \
    chmod 0555 /home/unitycatalog/lib-loom /home/unitycatalog/lib-loom-override; \
    chmod 0444 /home/unitycatalog/lib-loom/*.jar /home/unitycatalog/lib-loom-override/*.jar; \
    chown -R unitycatalog:unitycatalog /home/unitycatalog/lib-loom /home/unitycatalog/lib-loom-override; \
    grep -q 'loom-unity-entra-auth.jar' "${CP_FILE}" || { echo "FATAL: classpath rewrite did not take (Postgres/Entra jars missing)" >&2; exit 1; }; \
    case "$(cat "${CP_FILE}")" in \
      "${OVERRIDE}:"*) : ;; \
      *) echo "FATAL: the v0.5.1 unitycatalog-server override is not FIRST on the classpath — the v0.5.0 #1603 permission-GET-500 bug would still ship" >&2; exit 1 ;; \
    esac

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
LABEL csa.loom.upstream.server-override="io.unitycatalog:unitycatalog-server:0.5.1 (Maven Central overlay — #1603 permission-GET fix)"
