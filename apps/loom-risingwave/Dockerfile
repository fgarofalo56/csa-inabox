# CSA Loom — loom-risingwave streaming-SQL tier image (N7a, Openness Tier-2 T2-A).
#
# The STATEFUL-STREAMING tier ABOVE Azure Stream Analytics: an embedded, single-
# binary RisingWave (Apache-2.0) that authors streaming materialized views in
# SQL over Azure Event Hubs (consumed through its Kafka-protocol endpoint) and
# sinks the results to Delta/Iceberg on the deployment's own ADLS Gen2 (the N1
# lake) or serves them over the Postgres wire. Azure Stream Analytics stays the
# LIGHT default for simple jobs; RisingWave is the stateful tier (windowed joins,
# incremental aggregations, temporal joins) that ASA cannot express.
#
# WHY A PIN, NOT :latest — the engine binary is the whole capability; pinning an
# explicit Apache-2.0 release tag keeps the image reproducible and license-review
# stable (THIRD_PARTY_LICENSES.md → Container-baked engines).
#
# SOVEREIGN MOAT / IL5: RisingWave is a single self-contained Rust binary that
# runs single-node (meta + compute + frontend + compactor in one process) with
# NO external control plane. It reaches ONLY the Event Hubs Kafka endpoint the
# operator names in a CREATE SOURCE and the in-boundary ADLS Gen2 a CREATE SINK
# targets — both in-VNet. No SaaS streaming service, no Microsoft Fabric /
# OneLake / Power BI is in the path (.claude/rules/no-fabric-dependency.md), so
# the whole tier runs in an air-gapped Gov / IL5 enclave.
#
# Ports (single-node):
#   4566  Postgres-wire SQL frontend  — the ONLY port the Loom BFF connects to
#   5690  meta        (internal)
#   5691  dashboard   (internal HTTP)
#   1250  prometheus  (internal metrics scrape)
#
# Identity: the container carries a user-assigned managed identity (AZURE_CLIENT_ID
# injected by bicep) for the state store / lake hops — NO storage keys, NO SAS in
# the image. Source/sink credentials that a specific connector still needs are
# supplied per-DDL as Key-Vault-resolved values by the BFF, never baked here.
#
# PIN RE-VERIFIED 2026-07-28 (SC1 CRITICAL burn-down), UNCHANGED at v2.1.3.
#   The upstream line has moved on to v3.0.2, and that image does scan cleaner
#   (4 CRITICAL vs 105 here). It was NOT taken, for two reasons:
#     * it is a MAJOR engine bump — streaming state/SQL semantics and the wire
#       contract the Loom BFF (lib/azure/risingwave-client.ts) speaks to are in
#       scope for v2→v3, which is a functional migration that does not belong in
#       a CVE patch; and
#     * it does not even reach zero on its own — v3.0.2 still scans 4 CRITICAL
#       (redshift-jdbc42 CVE-2026-8178, another avro CVE-2024-47561 copy, and
#       grpc / go-stdlib CVE-2026-33186 / CVE-2025-68121 inside the bundled
#       Snowflake ADBC .so), so it would need its own hardening layer anyway.
#   The hardening below takes the pinned v2.1.3 to 0 CRITICAL instead. Revisit
#   the base bump as a deliberate, separately-validated engine upgrade.
FROM risingwavelabs/risingwave:v2.1.3

# ── SC1 supply-chain gate — OS layer ───────────────────────────────────────────
# The pinned base scans 84 CRITICALs on its ubuntu 24.04 layer, ALL of them
# kernel CVEs attributed to four packages that a running RisingWave never
# touches: `linux-libc-dev` (kernel headers, compile-time only) and the
# `linux-tools-*` set (perf/tooling).
#
# Two moves, because neither alone is sufficient:
#   1. PURGE the linux-tools packages. They are ABI-pinned to 6.8.0-52, so a
#      dist-upgrade does NOT fix them -- it installs a parallel 6.8.0-136 set and
#      leaves the vulnerable 6.8.0-52 ones in place (verified). Nothing depends
#      on them; the purge removes exactly those four packages and nothing else.
#      Purging happens FIRST so the upgrade does not pull a fresh ABI set in.
#   2. `dist-upgrade` -- the repo-standard SC1 hardening (same as
#      apps/fiab-mcp-bridge and apps/loom-transform-runner): it pulls the
#      distro's security patches AHEAD of the pinned base tag, taking
#      linux-libc-dev 6.8.0-52.53 -> 6.8.0-136.136 (past every fixed-version the
#      gate names) plus every other pending noble-security update.
#
# `linux-libc-dev` is upgraded rather than purged deliberately: purging it
# cascades into libc6-dev / build-essential / g++ / python3.12-dev, a footprint
# change to a third-party image that does not belong in a CVE patch.
#
# COST, measured: the pinned base is 18 months behind, so the blanket
# dist-upgrade rewrites ~200 packages (gcc-13, cpp-13, llvm, python3.12, glibc)
# into a new layer and takes the image 8.06 GB -> 9.61 GB. A minimal variant
# (`apt-get install -y --only-upgrade linux-libc-dev` in place of the
# dist-upgrade) was built and scanned too: it ALSO reaches 0 CRITICAL and stays
# at 8.09 GB. The blanket upgrade is shipped anyway because the CRITICAL-only
# gate is a floor, not the goal -- this container terminates a Postgres-wire
# listener and runs a JVM, and leaving 18 months of unpatched glibc / openssl /
# expat on it to save 1.5 GB is the wrong trade. If Container Apps pull time ever
# becomes the binding constraint, swapping the dist-upgrade line for the
# --only-upgrade line is the documented lever.
#
# `postgresql-client` is installed in the SAME layer, AFTER the dist-upgrade, so
# it resolves to the current noble-security build rather than an 18-month-old
# pin. It is not a convenience: the fail-closed authentication bootstrap
# (scripts/entrypoint.sh) needs a Postgres-wire client to run `ALTER USER root
# PASSWORD` against the sealed, loopback-only frontend before the port is ever
# bound to a routable address. The entrypoint refuses to start without it.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get purge -y 'linux-tools-*' \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client \
    && DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/*

# ── SC1 supply-chain gate — Java connector-node layer ─────────────────────────
# The remaining 21 CRITICALs all live in /risingwave/bin/connector-node/libs.
# Every fix, its justification and its assertions live in scripts/sc1-harden.sh
# (upgrade avro 1.11.3 -> 1.11.4; delete parquet-avro, which cannot class-load on
# this classpath even unmodified; delete htrace-core, whose shaded jackson 2.4.0
# accounts for 19 of the 21 and which sits in a provably dead jar island). The
# script also link-checks the resulting classpath with ConnectorLibsSmokeTest so
# a bad change fails the BUILD, not production.
#
# The script lives in a FILE rather than an inline heredoc on purpose: ACR Tasks'
# classic builder cannot parse Dockerfile heredocs (they need BuildKit). A
# heredoc here builds fine under a local `docker build` and then dies in CI after
# ~3s with `failed to run step ID: build: failed to scan dependencies: exit
# status 1`, before any layer runs -- an opaque message that names neither the
# heredoc nor the parser. Keep this Dockerfile BuildKit-feature-free.
COPY scripts/ /opt/loom-sc1/
RUN chmod 0755 /opt/loom-sc1/sc1-harden.sh \
    && /opt/loom-sc1/sc1-harden.sh \
    && install -m 0755 /opt/loom-sc1/entrypoint.sh /usr/local/bin/loom-risingwave-entrypoint.sh \
    && rm -rf /opt/loom-sc1

# The Loom BFF speaks to the frontend over the Postgres wire (4566). The other
# ports stay internal to the single-node process / the VNet.
EXPOSE 4566 5690 5691 1250

# ── AUTHENTICATION IS NOT OPTIONAL ────────────────────────────────────────────
# The previous CMD was a bare `single_node`, which is upstream's default: a
# `root` SUPERUSER with NO password on the Postgres wire. Deployed to the live
# Commercial estate on 2026-07-29 that put an unauthenticated database on the
# same Container Apps environment as loom-script-runner and loom-udf-runtime —
# two services that execute user-supplied code. It was removed from the estate.
#
# The entrypoint now:
#   1. REFUSES TO START unless LOOM_RW_ROOT_PASSWORD is present (delivered as a
#      Key-Vault-backed Container Apps secretRef, never a plain env literal);
#   2. boots the engine SEALED with the frontend on 127.0.0.1 only, applies
#      `ALTER USER root PASSWORD`, and proves an anonymous connection is now
#      rejected — all before any routable port exists;
#   3. only then re-execs the engine bound to 0.0.0.0.
# There is no unauthenticated code path left in this image.
ENTRYPOINT ["/usr/local/bin/loom-risingwave-entrypoint.sh"]

# BUILD-TIME ASSERTION — the same philosophy as scripts/sc1-harden.sh: a
# regression that would ship an open database fails the BUILD, not production.
# LOOM_RW_ROOT_PASSWORD is deliberately unset here, and LOOM_RW_BIN is pointed at
# /bin/true so nothing can actually start. If the entrypoint ever returns 0 in
# that state, someone has reintroduced an unauthenticated path and this layer
# stops the image from being produced at all.
RUN set -eu; \
    command -v psql >/dev/null 2>&1 || { echo "FATAL: psql is missing; the auth bootstrap cannot run" >&2; exit 1; }; \
    if LOOM_RW_BIN=/bin/true /usr/local/bin/loom-risingwave-entrypoint.sh >/dev/null 2>&1; then \
      echo "FATAL: the entrypoint started with NO LOOM_RW_ROOT_PASSWORD. An unauthenticated RisingWave must never be buildable." >&2; \
      exit 1; \
    fi; \
    echo "auth assertion passed: refuses to start without a credential, psql present"

# Extra `single_node` arguments only (the entrypoint supplies the binary, the
# listen address and the store directory). Override the state store to ADLS with
# RW_STATE_STORE / RW_DATA_DIRECTORY for a durable, scaled deployment.
CMD []
