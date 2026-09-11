# CSA Loom — loom-trino: the Federated SQL engine image (N7e).
#
# Trino OSS (Apache-2.0) as a SINGLE-NODE cluster (coordinator that also
# schedules work on itself), sized to run as an internal-ingress Azure
# Container App with minReplicas 0. That shape is what makes the "Federated SQL
# (Trino)" engine DEFAULT-ON per .claude/rules — an always-on AKS node pool is
# not required to answer a federated query, and a scale-to-zero Container App
# costs nothing while nobody is querying.
#
# The heavy multi-node AKS deployment still exists for scale-out
# (platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep) and is now the
# OPT-IN upgrade, not the only path.
#
# WHY A PIN, NOT :latest — the engine binary IS the capability. Pinning an
# explicit Apache-2.0 release keeps the image reproducible and license-review
# stable (THIRD_PARTY_LICENSES.md -> Container-baked engines), exactly like the
# sibling apps/loom-risingwave and apps/loom-duckdb images.
#
# SOVEREIGN MOAT / IL5: Trino is a self-contained JVM server. It reaches ONLY
# (a) the in-VNet Iceberg REST Catalog (N1) and the deployment's own ADLS Gen2
# over abfss://, and (b) whatever in-boundary external databases an operator
# adds as catalogs. There is NO SaaS query federation (no Starburst Galaxy, no
# Athena) and no Microsoft Fabric / OneLake / Power BI anywhere in the path
# (.claude/rules/no-fabric-dependency.md), so the whole tier runs in an
# air-gapped Gov / IL5 enclave.
#
# Ports:
#   8080  Trino HTTP protocol (/v1/statement) — the ONLY port the Loom BFF uses.
#
# Identity: the container carries a user-assigned managed identity
# (AZURE_CLIENT_ID injected by bicep). Trino's native Azure filesystem is
# configured with `azure.auth-type=DEFAULT`, which authenticates with that
# user-assigned managed identity. NO storage account keys, NO SAS, NO
# connection strings are baked here or passed as app settings.
FROM trinodb/trino:483

USER root

# Baked base configuration (single-node coordinator). Catalog property files are
# rendered at START-UP by the entrypoint from environment variables, so the same
# immutable image serves a deployment with an Iceberg REST Catalog and one
# without — no image rebuild to bind the lake.
COPY etc/config.properties   /etc/trino/config.properties
COPY etc/node.properties     /etc/trino/node.properties
COPY etc/jvm.config          /etc/trino/jvm.config
COPY etc/log.properties      /etc/trino/log.properties
COPY docker-entrypoint.sh    /usr/local/bin/loom-trino-entrypoint.sh

# The upstream image ships sample catalogs (tpch/tpcds/memory/jmx). Start from a
# clean slate so SHOW CATALOGS only ever lists what this deployment actually
# wired — no phantom catalogs that look like data.
RUN rm -rf /etc/trino/catalog && \
    mkdir -p /etc/trino/catalog /data/trino && \
    chown -R trino:trino /etc/trino /data/trino && \
    chmod +x /usr/local/bin/loom-trino-entrypoint.sh

# ── SC1 supply-chain gate — Java layer (#4429) ────────────────────────────────
# CVE-2026-75595 (CRITICAL) in io.netty:netty-handler 4.2.16.Final, which this
# base ships in FIFTEEN plugin directories — Trivy de-duplicates the finding and
# prints only one of them, so the fix is driven off the image's own file list,
# not off the scanner's representative path. Every justification, digest and
# assertion lives in scripts/sc1-netty.sh; scripts/NettyLinkCheck.java re-proves
# the swapped jar's class-level references against the REAL plugin classpath at
# BUILD time, so a bad change fails the build rather than production.
#
# A base bump was checked FIRST and is not available: trinodb/trino:483 is
# :latest (same digest), and it predates netty 4.2.17.Final.
#
# The script lives in a FILE rather than an inline heredoc on purpose: ACR Tasks'
# classic builder cannot parse Dockerfile heredocs (they need BuildKit). A
# heredoc here builds fine under a local `docker build` and then dies in CI after
# ~3s with `failed to run step ID: build: failed to scan dependencies: exit
# status 1`, before any layer runs. Keep this Dockerfile BuildKit-feature-free.
COPY scripts/ /opt/loom-sc1/
RUN chmod 0755 /opt/loom-sc1/sc1-netty.sh \
    && /opt/loom-sc1/sc1-netty.sh \
    && rm -rf /opt/loom-sc1

USER trino:trino

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/loom-trino-entrypoint.sh"]
CMD ["/usr/lib/trino/bin/launcher", "run", "--etc-dir", "/etc/trino"]
