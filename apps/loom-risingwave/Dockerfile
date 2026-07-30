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
# PORTS — MEASURED, not assumed. This comment previously claimed the engine
# listened on 4566/5690/5691/1250 and described the last three as "internal".
# Both halves were wrong, and the wrong list is what hid a real hole through
# three review rounds. Read off `/proc/net/tcp` inside a running stock
# `risingwave single_node` on THIS pinned tag:
#
#   0.0.0.0:4566     Postgres-wire SQL frontend        credential-gated (below)
#   0.0.0.0:5688     compute-node gRPC                 NO AUTH  <- was undocumented
#   0.0.0.0:5690     meta-node gRPC                    NO AUTH
#   0.0.0.0:5691     meta dashboard HTTP + REST API    NO AUTH
#   0.0.0.0:6660     compactor gRPC                    NO AUTH  <- was undocumented
#   127.0.0.1:1260   prometheus metrics                loopback (1222/2222 collapse here)
#   127.0.0.1:6786   frontend health-check gRPC        loopback
#
# "Internal" is not a property of a Container Apps port. Ingress publishes only
# `targetPort`, but a replica holds a VNet IP from the environment's
# infrastructure subnet, so a sibling app reaches ANY listening port on the pod
# IP directly — bypassing ingress and its IP rules entirely.
#
# scripts/entrypoint.sh therefore runs the engine in `standalone` mode (which
# exposes per-node options; `single_node` hard-codes 0.0.0.0 and offers no flag
# for meta/compute/compactor/dashboard) with every non-wire listener pinned to
# 127.0.0.1, and ASSERTS the resulting surface at runtime. Net effect: FIVE
# routable ports become ONE, and that one requires a password.
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

# ONE port, deliberately. The Loom BFF speaks to the frontend over the Postgres
# wire; meta (5690), the dashboard (5691), compute (5688) and the compactor
# (6660) are bound to 127.0.0.1 by scripts/entrypoint.sh and are NOT reachable
# from outside the container, so declaring them here would advertise a surface
# that does not exist. Reach the dashboard with
# `az containerapp exec … -- curl 127.0.0.1:5691` if you need it.
EXPOSE 4566

# ── AUTHENTICATION IS NOT OPTIONAL, AND NEITHER IS THE PORT SEAL ──────────────
# The original CMD was a bare `single_node`, which is upstream's default: a
# `root` SUPERUSER with NO password on the Postgres wire AND four completely
# unauthenticated gRPC/HTTP services on 5688 / 5690 / 5691 / 6660. Deployed to
# the live Commercial estate on 2026-07-29 that put all five on the same
# Container Apps environment as loom-script-runner and loom-udf-runtime — two
# services that execute user-supplied code. It was removed from the estate.
#
# The entrypoint now:
#   1. REFUSES TO START unless LOOM_RW_ROOT_PASSWORD is present (delivered as a
#      Key-Vault-backed Container Apps secretRef, never a plain env literal);
#   2. boots the engine SEALED — frontend, meta, compute, compactor and
#      dashboard ALL on 127.0.0.1 — and asserts ZERO routable listening sockets
#      before touching anything;
#   3. applies `ALTER USER root PASSWORD` and proves an anonymous connection is
#      now rejected while still sealed;
#   4. restarts SERVING with only the frontend on 0.0.0.0 and asserts that the
#      routable surface is EXACTLY that one port, dying rather than serving if
#      anything else is reachable.
# There is no unauthenticated code path and no unauthenticated port left.
ENTRYPOINT ["/usr/local/bin/loom-risingwave-entrypoint.sh"]

# BUILD-TIME ASSERTIONS — the same philosophy as scripts/sc1-harden.sh: a
# regression that would ship an open database fails the BUILD, not production.
#
#   (a) psql must exist, or the credential bootstrap cannot run.
#   (b) With LOOM_RW_ROOT_PASSWORD unset (and LOOM_RW_BIN pointed at /bin/true
#       so nothing can start), the entrypoint must exit non-zero. A zero exit
#       means someone reintroduced an unauthenticated path.
#   (c) `--selftest` runs the routable-vs-loopback classifier against a
#       synthetic /proc/net/tcp + /proc/net/tcp6 snapshot. This is asserted
#       because a broken hex comparison there would make BOTH runtime port
#       assertions pass vacuously — a green gate measuring nothing.
RUN set -eu; \
    command -v psql >/dev/null 2>&1 || { echo "FATAL: psql is missing; the auth bootstrap cannot run" >&2; exit 1; }; \
    if LOOM_RW_BIN=/bin/true /usr/local/bin/loom-risingwave-entrypoint.sh >/dev/null 2>&1; then \
      echo "FATAL: the entrypoint started with NO LOOM_RW_ROOT_PASSWORD. An unauthenticated RisingWave must never be buildable." >&2; \
      exit 1; \
    fi; \
    /usr/local/bin/loom-risingwave-entrypoint.sh --selftest; \
    echo "assertions passed: refuses to start without a credential, psql present, port classifier correct"

# Extra `risingwave standalone` flags only — that is the subcommand the
# entrypoint runs (`single_node` cannot bind meta/compute/compactor anywhere but
# 0.0.0.0, so it is no longer used). The entrypoint supplies the binary, every
# per-node listen address and the store paths. Override the state store to ADLS
# with RW_STATE_STORE / RW_DATA_DIRECTORY for a durable deployment — under
# `standalone` those env vars now actually take effect, where `single_node`
# silently overwrote them with the local-filesystem store.
CMD []
