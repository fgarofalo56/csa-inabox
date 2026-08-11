# CSA Loom — loom-sharing: the OSS Delta Sharing reference server, packaged.
#
# LU-9. Gives Azure Government an open-protocol Delta Sharing endpoint over the
# SAME ADLS Gen2 Delta tables the Loom lakehouse already writes. Databricks
# Delta Sharing has no Azure Government endpoint, and OSS Unity Catalog 0.5 does
# not implement the sharing server at all (upstream roadmap marks it ❓), so the
# only license-clean, in-boundary way to speak the protocol is the reference
# server from the protocol's own project.
#
# This is PACKAGING, not a fork: we start FROM the official published image and
# overlay a thin config-rendering entrypoint. No upstream source is modified.
#
# ── LICENSE (LIC0) ─────────────────────────────────────────────────────────
#   Upstream project: github.com/delta-io/delta-sharing — Apache-2.0
#     (confirmed 2026-07-28 via the GitHub licence API: spdx_id "Apache-2.0";
#      every server source file carries the Apache-2.0 header).
#   Artifact used:    docker.io/deltaio/delta-sharing-server — the image the
#     upstream build publishes (build.sbt: dockerUsername := Some("deltaio"),
#     JavaAppPackaging), i.e. the SAME Apache-2.0 codebase, not a third-party
#     or differently-licensed redistribution.
#   Recorded in THIRD_PARTY_LICENSES.md and enforced by
#   scripts/ci/check-license-inventory.mjs (REVIEWED_IMAGES).
#
# ── IMAGE-TAG PIN — verified 2026-07-28 ────────────────────────────────────
#   Pinned to v0.7.8, which is the NEWEST tag the upstream Docker Hub repository
#   publishes (pushed 2024-04-23):
#     GET https://hub.docker.com/v2/repositories/deltaio/delta-sharing-server/tags
#       -> newest by last_updated: 0.7.8 (2024-04-23); then 0.7.7, 0.6.11, …
#   Upstream has since cut GitHub releases up to v1.4.1 (2026-07-22) but has NOT
#   published images or release binaries for them (the v1.4.1 release carries
#   zero assets), so there is nothing newer to pin TO. `latest` is deliberately
#   NOT used — an unpinned base is a supply-chain hole, and re-tagging `latest`
#   would silently change the server under a running estate.
#
#   ── WHY THE UPSTREAM IMAGE IS NOT THE RUNTIME BASE (#2619, measured) ─────
#   `FROM deltaio/delta-sharing-server:0.7.8` — the shape this file shipped with
#   — CANNOT BE BUILT OR RUN by this platform. Two measured reasons:
#
#   1. ARCHITECTURE. Every published tag from 0.6.8 (2023-06-16) onward is a
#      SINGLE-PLATFORM linux/arm64/v8 manifest; the last amd64 publication is
#      0.6.7 (2023-06-02). Verified against the Docker Hub tag API — 27 tags,
#      not one of them a multi-arch manifest list. Azure Container Apps runs
#      amd64. So the previous single-stage form failed at BUILD time on any
#      amd64 builder (`az acr build` included) — the RUN below execs /bin/sh out
#      of an arm64 rootfs and gets `exec format error` — and, had it been built,
#      would have CrashLoopBackOff'd on ACA for the same reason.
#   2. CVEs. `trivy --ignore-unfixed --severity CRITICAL,HIGH` on that image: 75
#      CRITICAL / 353 HIGH, split 37 C / 216 H in the Debian 11.4 OS layer (April
#      2024, fixable) and 38 C / 137 H inside /opt/docker/lib itself —
#      htrace-core4-4.1.0 (shading jackson-databind 2.4.0), hadoop-common-2.10.1,
#      spark-core 2.4.7, zookeeper-3.4.14, netty-3.10.6, avro-1.8.2. Those travel
#      WITH the payload, so the previously-tracked "re-base onto a patched
#      runtime" follow-up clears at most 37 of 75 on its own. See "residual
#      CVEs" below.
#
#   THE FIX: a two-stage build. The upstream image is used ONLY as a file source
#   (`COPY --from=payload`); nothing in it is ever executed on the builder, so
#   its architecture stops mattering — /opt/docker is JVM bytecode plus a bash
#   launcher, both architecture-independent (the upstream base is openjdk:8u342,
#   i.e. Java 8, confirmed off the image config). The runtime stage is a current,
#   amd64, Ubuntu-24.04-based Temurin 8 JRE, dist-upgraded at build time.
#
#   STILL PACKAGING, NOT A FORK: no upstream source is modified or rebuilt. The
#   exact Apache-2.0 artifacts the upstream build published are what run.
#
#   RESIDUAL CVEs, stated honestly rather than muted: the 38 CRITICAL findings
#   in the copied /opt/docker/lib jars REMAIN after this change, because they are
#   the upstream server's own dependency set and only an upstream rebuild clears
#   them. NOTHING is added to .trivyignore for them — that baseline is
#   deliberately empty and an ignore is a loan, not a fix. This is why the
#   Container App is INTERNAL-ingress-only with an IP allow-list and is never the
#   recipient-facing endpoint (recipients terminate on the Console BFF), and it
#   is why .github/workflows/deploy-loom-sharing.yml runs the Trivy CRITICAL gate
#   as a REPORT-AND-REFUSE step rather than pretending the image is clean.
#   Tracked in docs/fiab/security/loom-sharing-threat-model.md, "base image
#   currency".
#
# Build: docker build -t loom-sharing .
# Run (local dry-run of the rendered config, no JVM):
#   docker run --rm -e LOOM_SHARING_DRYRUN=1 -e LOOM_SHARING_BEARER=dev loom-sharing
#
# Azure-native only — no Microsoft Fabric / Power BI / OneLake dependency
# (.claude/rules/no-fabric-dependency.md).

# ── Stage 1: PAYLOAD SOURCE ONLY. Never executed. ──────────────────────────
# NO `--platform=` FLAG HERE, and that is load-bearing rather than an omission.
#
# ACR Tasks' Dockerfile dependency scanner cannot parse a platform flag on FROM.
# Measured on the FIRST-EVER run of deploy-loom-sharing.yml (31503836350,
# 2026-08-11), which is why that workflow's staleness entry read "NEVER RUN":
#
#   unable to understand line FROM --platform=linux/arm64 \
#     deltaio/delta-sharing-server:0.7.8 AS payload
#   failed to run step ID: build: failed to scan dependencies: exit status 1
#   Run ID: cj3sv failed after 4s.
#
# `az acr build` is the ONLY mechanism that can reach these registries — they are
# provisioned publicNetworkAccess=Disabled, so a client-side docker push cannot
# push to them at all. A Dockerfile ACR Tasks cannot parse is therefore a
# Dockerfile that can never ship, no matter that `docker build` accepts it.
#
# Removing the flag changes NOTHING about what is pulled, by this file's own
# earlier reasoning: the upstream ref resolves to a single-platform arm64
# manifest, so a plain FROM pulls that same image and merely emits an
# InvalidBaseImagePlatform warning. The stage is a file source only
# (`COPY --from=payload`); nothing in it is ever executed on the builder, so its
# architecture does not matter. The constraint stays reviewable — it is stated
# here, at length, instead of in a flag that costs us the build.
FROM deltaio/delta-sharing-server:0.7.8 AS payload

# ── Stage 2: the runtime Loom actually ships. ──────────────────────────────
# Temurin 8 (Ubuntu 24.04 LTS) — the same Java 8 the upstream image carried
# (openjdk 8u342), on a base that is still receiving security updates. The
# dist-upgrade is the loom-mcp-bridge precedent (#2527): it pulls the archive's
# current patch set ahead of the pinned tag, so the OS layer is current at build
# time rather than at tag-publish time.
FROM eclipse-temurin:8-jre-noble

USER root

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y --no-install-recommends dist-upgrade \
 && apt-get -y autoremove --purge \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# The upstream runtime user. sbt-native-packager's rootless default is uid 1001 /
# gid 0 and /opt/docker is owned by it; recreate that posture explicitly here
# because a fresh JRE base has no such account. A numeric USER works without a
# passwd entry, but several JVM paths read `user.name`, so the account is real.
RUN groupadd -g 1001 loomsharing 2>/dev/null || true \
 && useradd -u 1001 -g 0 -G 1001 -m -s /usr/sbin/nologin loomsharing

# The published application payload, byte-for-byte. JVM bytecode + a bash
# launcher; no native binary in the launch path (snappy/lz4 ship per-arch
# objects INSIDE their jars and select at runtime).
COPY --from=payload --chown=1001:0 /opt/docker /opt/docker

# /opt/docker/conf is on the launcher classpath (build.sbt:
# scriptClasspath ++= Seq("../conf")) and is therefore the ONLY directory where
# a rendered core-site.xml is picked up by Hadoop. sbt only materialises it when
# the build has conf files, so create it and hand it to the runtime user.
RUN mkdir -p /opt/docker/conf /opt/loom/etc \
 && chown -R 1001:0 /opt/docker/conf /opt/loom \
 && chmod 0750 /opt/docker/conf /opt/loom/etc

COPY --chown=1001:0 bin/loom-sharing-entrypoint.sh /opt/loom/bin/loom-sharing-entrypoint.sh

# Fail the BUILD, not the deployment, if the upstream layout moved: an image
# whose entrypoint execs a launcher that does not exist would CrashLoopBackOff
# in the estate with an opaque error instead of here with a clear one. This
# assertion is only MEANINGFUL now that the final stage is native to the build
# platform — in the previous single-stage arm64 form it could not run at all.
RUN chmod 0755 /opt/loom/bin/loom-sharing-entrypoint.sh \
 && if [ ! -x /opt/docker/bin/delta-sharing-server ]; then \
      echo "FATAL: /opt/docker/bin/delta-sharing-server not found or not executable — upstream image layout changed; update apps/loom-sharing/bin/loom-sharing-entrypoint.sh (APP_HOME)" >&2; \
      exit 1; \
    fi \
 && java -version 2>&1 | head -1

USER 1001
WORKDIR /opt/docker

EXPOSE 8080
ENV LOOM_SHARING_PORT=8080

ENTRYPOINT ["/opt/loom/bin/loom-sharing-entrypoint.sh"]

LABEL org.opencontainers.image.title="Loom Sharing (open Delta Sharing server for Azure Government)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL csa.loom.component="loom-sharing"
LABEL csa.loom.version="0.2.0"
LABEL csa.loom.upstream="deltaio/delta-sharing-server:0.7.8 (payload only; arm64-published, re-based onto eclipse-temurin:8-jre-noble for amd64 — #2619)"
