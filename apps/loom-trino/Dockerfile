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

USER trino:trino

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/loom-trino-entrypoint.sh"]
CMD ["/usr/lib/trino/bin/launcher", "run", "--etc-dir", "/etc/trino"]
