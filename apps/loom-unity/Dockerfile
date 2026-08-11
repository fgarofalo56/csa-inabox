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
#   from source. NARROWED 2026-08-10: the overlay is no longer the whole 419-class
#   artifact but the THREE classes that actually differ between v0.5.0 and v0.5.1
#   and carry the #1603 fix (PermissionService, PermissionService$1,
#   AuthorizeExpressions) — taken verbatim from upstream's released jar, digest-
#   pinned per class. Full measurement and rationale in the stage-1 header.
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
#   WHAT THE OVERLAY DOES *NOT* CAUSE (corrected 2026-08-10). The Iceberg
#   LIST-namespaces 500 ("Authorization filter not initialized") was previously
#   attributed to this overlay. That attribution was WRONG, and it was wrong
#   because the "control" changed two variables at once (bare image AND
#   authorization disabled). Re-measured with ONE variable — the same Loom image
#   with the overlay stripped off the classpath, authorization still ENABLED —
#   the route still answers 500, byte-for-byte the same error. The three overlaid
#   classes are not on that code path at all, and `AuthorizedService`,
#   `SchemaService`, `IcebergRestCatalogService`, `UnityAccessDecorator` and
#   `ResultFilter` are BYTE-IDENTICAL in v0.5.0 and v0.5.1. It is an upstream
#   defect present in BOTH releases that fires whenever `server.authorization` is
#   enabled — see tests/authz/iceberg-e2e.sh (which now runs that single-variable
#   control) and docs/fiab/parity/external-engine-federation.md.
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

# ── #1603 overlay — NARROWED to the three classes that actually differ ─────────
# The permission GET routes 500 under server.authorization=enable on v0.5.0
# (issue #1603). Docker Hub never published the v0.5.1 IMAGE, but Maven Central
# publishes the v0.5.1 SERVER MODULE — io.unitycatalog:unitycatalog-server:0.5.1,
# upstream's own released binary. Stage 2 PREPENDS the overlay to the server
# classpath so its (fixed) classes shadow the v0.5.0 base copies; see the header
# rationale for why this is packaging, not a fork.
#
# ── WHY A 3-CLASS JAR AND NOT THE WHOLE 419-CLASS ARTIFACT ────────────────────
# MEASURED 2026-08-10, by extracting both released jars and hashing every entry
# (temp/uc051, reproduced in the PR body). The v0.5.0 -> v0.5.1 delta is FIVE
# entries, and only THREE of them matter:
#
#   io/unitycatalog/server/service/PermissionService.class     <- the #1603 fix
#   io/unitycatalog/server/service/PermissionService$1.class   <- its synthetic sibling
#   io/unitycatalog/server/auth/AuthorizeExpressions.class     <- adds the constant it uses
#   io/unitycatalog/server/utils/VersionUtils.class            <- version STRING only, excluded
#   META-INF/MANIFEST.MF                                       <- version strings only
#
# The whole #1603 fix is ONE ADDED ANNOTATION —
#   @AuthorizeExpression("#principal != null")   (AuthorizeExpressions.GET_RESOURCE_AUTHORIZATION)
# on the permission GET handler. Every other one of the 419 entries is
# BYTE-IDENTICAL between v0.5.0 and v0.5.1, so prepending the full jar shadowed
# 416 classes with exact copies of themselves — no behaviour change, but a large
# and invisible blast radius:
#
#   * it made the overlay UNFALSIFIABLE by inspection — "the overlay broke X" could
#     not be checked against a short list, and one such claim (the Iceberg
#     LIST-namespaces 500) was in fact WRONG; see tests/authz/iceberg-e2e.sh, which
#     now carries a real single-variable control, and the parity doc; and
#   * it is a live hazard the day the BASE TAG moves: a full-jar overlay would
#     silently revert an entire newer server module to v0.5.1 classes. The
#     narrowed overlay reverts three, and the stage-2 digest assertions below FAIL
#     THE BUILD if the base's copies are no longer the v0.5.0 ones this was
#     derived against.
#
# VersionUtils is deliberately EXCLUDED: it carries only the string "0.5.1", and
# this image is v0.5.0 plus a three-class patch, not v0.5.1. Letting the server
# report 0.5.0 keeps /version honest; the overlay is recorded in the LABELs.
#
# Pin the artifact AND its SHA-256. The digest below was verified by downloading
# the jar from Maven Central on 2026-08-04 and hashing it locally — it matched
# both the value hashed locally and the published `.jar.sha256` sidecar (and was
# re-verified 2026-08-10). A tampered or truncated download fails the build
# instead of shipping the bug back. Each EXTRACTED class is then pinned too, so a
# re-released artifact cannot quietly change what we overlay.
ARG UC_SERVER_VERSION=0.5.1
ARG UC_SERVER_SHA256=df8647d5a0e2b72c623fff5c2cf6f08a739a33e34aea960dfbd862495ef3b027
ARG UC_PERMISSIONSERVICE_SHA256=9238d2e8baedf8816b32f28611996a7baf7d77398b6f1aabe5669549f9f8f226
ARG UC_PERMISSIONSERVICE1_SHA256=ab7e8a408f4db5664950550c563109f7d5936e204553b2841d2ed7df9ea291c7
ARG UC_AUTHORIZEEXPRESSIONS_SHA256=7cb0e68dbd8a17374ab2dda81f212c95bd49ce4f744cb9d1af0df51cf6f6df66
RUN set -eu; \
    mkdir -p /build/override /build/ucfull /build/ucnarrow; \
    curl -fsSL -o /build/unitycatalog-server-full.jar \
      "https://repo1.maven.org/maven2/io/unitycatalog/unitycatalog-server/${UC_SERVER_VERSION}/unitycatalog-server-${UC_SERVER_VERSION}.jar"; \
    echo "${UC_SERVER_SHA256}  /build/unitycatalog-server-full.jar" | sha256sum -c -; \
    cd /build/ucfull; \
    jar --extract --file /build/unitycatalog-server-full.jar \
      io/unitycatalog/server/service/PermissionService.class \
      'io/unitycatalog/server/service/PermissionService$1.class' \
      io/unitycatalog/server/auth/AuthorizeExpressions.class; \
    echo "${UC_PERMISSIONSERVICE_SHA256}  io/unitycatalog/server/service/PermissionService.class" | sha256sum -c -; \
    echo "${UC_PERMISSIONSERVICE1_SHA256}  io/unitycatalog/server/service/PermissionService\$1.class" | sha256sum -c -; \
    echo "${UC_AUTHORIZEEXPRESSIONS_SHA256}  io/unitycatalog/server/auth/AuthorizeExpressions.class" | sha256sum -c -; \
    jar --create --file /build/override/loom-uc-1603-fix.jar -C /build/ucfull .; \
    ENTRIES="$(jar --list --file /build/override/loom-uc-1603-fix.jar | grep -c '\.class$')"; \
    [ "${ENTRIES}" -eq 3 ] || { echo "FATAL: narrowed overlay carries ${ENTRIES} classes, expected exactly 3" >&2; exit 1; }

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
#   PREPEND  lib-loom-override/loom-uc-1603-fix.jar (THREE classes taken verbatim
#            from upstream's released v0.5.1 artifact) — placed BEFORE the v0.5.0
#            server/target/classes so the #1603-fixed PermissionService wins the
#            first-match scan. This is the whole point of the overlay. Every other
#            v0.5.0 class keeps resolving from the base image, which is what we
#            want: they are byte-identical in v0.5.1 anyway (measured — see the
#            stage-1 header), so shadowing them bought nothing and hid a lot.
#   APPEND   lib-loom/* (Postgres driver + Entra auth plugin) — purely additive,
#            unique classes, so their position does not matter.
#
# The build FAILS LOUDLY if the classpath file is missing, the Postgres/Entra
# rewrite does not take, or the override is not FIRST on the path — a shadowed
# override would silently ship the v0.5.0 500-on-permission-GET bug while claiming
# to fix it, which is exactly the failure this assertion exists to catch.
#
# ── BASE-DRIFT ASSERTION (new with the narrowing) ─────────────────────────────
# A narrow overlay is only correct while the base image's copies of those three
# classes are the v0.5.0 ones it was derived against. If the base tag is ever
# bumped, silently reverting three classes of a NEWER server to v0.5.1 would be a
# real regression — and, unlike the full-jar overlay, it would be a subtle one.
# So the build hashes the base's own copies and REFUSES TO BUILD if they have
# moved: the next person gets a loud, specific failure telling them to re-derive
# the overlay against the new base, not a silent behaviour change.
#
# ── WHY *EVERY* CLASSPATH FILE, AND WHY THE ASSERTION NAMES THE EXACT FILE ─────
# (finishline D2, root-caused LIVE on Commercial 2026-08-06.) The upstream image
# carries EIGHT `classpath` files (server, controlmodels, models, clients/java,
# clients/python, examples/cli, target, target/control). The previous version of
# this block patched `find ... -path '*server/target*' | head -n 1`, and find's
# traversal order returned `server/target/controlmodels/target/classpath` —
# NOT `server/target/classpath`, the file bin/start-uc-server actually reads
# (`SERVER_CLASSPATH_FILE="$SERVER_TARGET_DIR/classpath"`). Every build-time
# assertion then passed against the WRONG file, and the shipped image had:
#   * NO Postgres driver/Entra plugin on the RUNNING classpath — the first live
#     Entra-Postgres boot died with "Unable to load Authentication Plugin"
#     (ClassNotFoundException, reproduced in-image via
#     `java -cp "$(cat server/target/classpath)" ai.limitlessdata...`), and
#   * the v0.5.1 #1603 override INERT — the server was running v0.5.0 classes
#     while the image claimed the permission-GET fix.
# Rewriting every classpath file is idempotent-shaped (skip if already present),
# robust to upstream layout changes, and harmless for the aux files (their tools
# just gain two jars). The assertions then check the ONE file the start script
# names, not whichever file find happened to return first.
COPY --from=jdbcplugin /build/lib/ /home/unitycatalog/lib-loom/
COPY --from=jdbcplugin /build/override/ /home/unitycatalog/lib-loom-override/
RUN set -eu; \
    SERVER_CP_FILE=/home/unitycatalog/server/target/classpath; \
    if [ ! -f "${SERVER_CP_FILE}" ]; then \
      echo "FATAL: ${SERVER_CP_FILE} not found — bin/start-uc-server reads exactly this file, so the #1603 override and the Postgres driver cannot be installed" >&2; \
      exit 1; \
    fi; \
    OVERRIDE="$(find /home/unitycatalog/lib-loom-override -name '*.jar' | sort | tr '\n' ':' | sed 's/:$//')"; \
    EXTRA="$(find /home/unitycatalog/lib-loom -name '*.jar' | sort | tr '\n' ':' | sed 's/:$//')"; \
    if [ -z "${OVERRIDE}" ]; then echo "FATAL: the #1603 override jar was not found in lib-loom-override" >&2; exit 1; fi; \
    BASE_CLASSES=/home/unitycatalog/server/target/classes; \
    for PAIR in \
      "f7ffa437ab66d3eb49675fb7c7bbfd37a2eb1b4b73b7081ece49573ee81c9176:io/unitycatalog/server/service/PermissionService.class" \
      "2f3c74023a051b1ab9b43b58ea2631d2bbff4d7a9f37eec167233e1b7519799b:io/unitycatalog/server/service/PermissionService\$1.class" \
      "f9ad9832f79c2949e71bac534c79eb1aa78cb7d114f53409b7467e63698a0a91:io/unitycatalog/server/auth/AuthorizeExpressions.class" \
    ; do \
      WANT="${PAIR%%:*}"; REL="${PAIR#*:}"; \
      if [ ! -f "${BASE_CLASSES}/${REL}" ]; then \
        echo "FATAL: ${REL} is absent from the base image's server classes — the narrowed #1603 overlay was derived against unitycatalog/unitycatalog:v0.5.0 and cannot be reasoned about on this base. Re-derive it (see the stage-1 header) before bumping the base tag." >&2; exit 1; \
      fi; \
      GOT="$(sha256sum "${BASE_CLASSES}/${REL}" | cut -d' ' -f1)"; \
      if [ "${GOT}" != "${WANT}" ]; then \
        echo "FATAL: base-image drift. ${REL} hashes ${GOT}, expected the v0.5.0 value ${WANT}. The base tag has moved, so prepending the v0.5.1 copy of this class would REVERT a newer server class instead of patching v0.5.0. Re-derive the narrowed overlay against the new base (diff the released jars, keep only the classes that differ AND carry the #1603 fix) and update the ARG digests." >&2; exit 1; \
      fi; \
    done; \
    for CP_FILE in $(find /home/unitycatalog -type f -name classpath); do \
      if ! grep -q 'loom-unity-entra-auth.jar' "${CP_FILE}"; then \
        printf '%s:%s:%s' "${OVERRIDE}" "$(cat "${CP_FILE}")" "${EXTRA}" > /tmp/loom-classpath; \
        cat /tmp/loom-classpath > "${CP_FILE}"; \
        rm -f /tmp/loom-classpath; \
      fi; \
    done; \
    chmod 0555 /home/unitycatalog/lib-loom /home/unitycatalog/lib-loom-override; \
    chmod 0444 /home/unitycatalog/lib-loom/*.jar /home/unitycatalog/lib-loom-override/*.jar; \
    chown -R unitycatalog:unitycatalog /home/unitycatalog/lib-loom /home/unitycatalog/lib-loom-override; \
    grep -q 'loom-unity-entra-auth.jar' "${SERVER_CP_FILE}" || { echo "FATAL: classpath rewrite did not take on ${SERVER_CP_FILE} (Postgres/Entra jars missing from the file the server boots from)" >&2; exit 1; }; \
    case "$(cat "${SERVER_CP_FILE}")" in \
      "${OVERRIDE}:"*) : ;; \
      *) echo "FATAL: the #1603 override jar is not FIRST on ${SERVER_CP_FILE} — the v0.5.0 permission-GET-500 bug would still ship" >&2; exit 1 ;; \
    esac; \
    java -cp "$(cat "${SERVER_CP_FILE}")" ai.limitlessdata.loom.unity.EntraPostgresAuthPlugin 2>&1 | grep -q 'Main method not found' || { \
      echo "FATAL: EntraPostgresAuthPlugin does NOT load from the server's real classpath (expected 'Main method not found' = class resolvable; got ClassNotFoundException?) — the Entra-Postgres boot would die with 'Unable to load Authentication Plugin'" >&2; \
      exit 1; }

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
LABEL csa.loom.upstream.server-override="io.unitycatalog:unitycatalog-server:0.5.1 — 3 classes only (PermissionService, PermissionService\$1, AuthorizeExpressions): the #1603 permission-GET fix"
