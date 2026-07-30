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
#   HONEST CAVEAT, carried into the threat model: the 0.7.8 image's OS/JRE layer
#   is from April 2024 and therefore carries unpatched base-image CVEs. This is
#   the reason the Container App is INTERNAL-ingress-only with an IP allow-list
#   and is never the recipient-facing endpoint — recipients terminate on the
#   Console BFF. Re-basing the upstream /opt/docker payload onto a currently
#   patched Corretto 8 runtime is the tracked follow-up
#   (docs/fiab/security/loom-sharing-threat-model.md, "base image currency");
#   it is not done here because it cannot be validated without building and
#   booting the image against a real ADLS Delta table.
#
# Build: docker build -t loom-sharing .
# Run (local dry-run of the rendered config, no JVM):
#   docker run --rm -e LOOM_SHARING_DRYRUN=1 -e LOOM_SHARING_BEARER=dev loom-sharing
#
# Azure-native only — no Microsoft Fabric / Power BI / OneLake dependency
# (.claude/rules/no-fabric-dependency.md).

FROM deltaio/delta-sharing-server:0.7.8

# Root only for the overlay. The upstream image (sbt-native-packager 1.7.6,
# rootless defaults) runs as uid 1001 / gid 0 with /opt/docker owned by that
# user; USER 1001 is restored below so the runtime posture is unchanged.
USER root

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
# in the estate with an opaque error instead of here with a clear one.
RUN chmod 0755 /opt/loom/bin/loom-sharing-entrypoint.sh \
 && if [ ! -x /opt/docker/bin/delta-sharing-server ]; then \
      echo "FATAL: /opt/docker/bin/delta-sharing-server not found or not executable — upstream image layout changed; update apps/loom-sharing/bin/loom-sharing-entrypoint.sh (APP_HOME)" >&2; \
      exit 1; \
    fi

USER 1001
WORKDIR /opt/docker

EXPOSE 8080
ENV LOOM_SHARING_PORT=8080

ENTRYPOINT ["/opt/loom/bin/loom-sharing-entrypoint.sh"]

LABEL org.opencontainers.image.title="Loom Sharing (open Delta Sharing server for Azure Government)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL csa.loom.component="loom-sharing"
LABEL csa.loom.version="0.1.0"
LABEL csa.loom.upstream="deltaio/delta-sharing-server:0.7.8"
