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
FROM risingwavelabs/risingwave:v2.1.3

# The Loom BFF speaks to the frontend over the Postgres wire (4566). The other
# ports stay internal to the single-node process / the VNet.
EXPOSE 4566 5690 5691 1250

# `single_node` runs the all-in-one node: meta + compute + frontend + compactor
# in one process with local state (override the state store to ADLS with
# RW_STATE_STORE / RW_DATA_DIRECTORY when a durable, scaled deployment is wanted).
CMD ["single_node"]
