#!/usr/bin/env bash
# CSA Loom — Cosmos catalog seeding script.
#
# Seeds the `apps-catalog` and `workloads-catalog` containers with curated
# CSA content. Idempotent — re-running upserts the same set.
#
# Run after `deploy-v2-synapse.sh` (or any time you want to refresh the
# seed content). Authenticated via `az login` (the running user must have
# Cosmos DB Built-in Data Contributor on the account).

set -euo pipefail
export MSYS_NO_PATHCONV=1

SUB="${LOOM_SUBSCRIPTION_ID:-363ef5d1-0e77-4594-a530-f51af23dbf8c}"
DLZ_RG="${LOOM_DLZ_RG:-rg-csa-loom-dlz-single-eastus2}"
COSMOS="${LOOM_COSMOS_ACCOUNT:-cosmos-loom-default-mwfaiy3trukkk}"
DB="${LOOM_COSMOS_DATABASE:-loom}"
# Seed under a synthetic "global tenant" id; the BFF reads against
# session.claims.oid — when users sign in their tenant will get a copy
# via /api/apps-catalog/copy-defaults (called on first /api/apps-catalog GET
# that returns []). For now use the literal "GLOBAL" so the BFF can find
# them in tests.
TENANT="${LOOM_SEED_TENANT:-GLOBAL}"

az account set --subscription "$SUB" >/dev/null

echo "==> Seeding apps-catalog (15 curated CSA apps)..."
APPS=$(cat <<JSON
[
  {"id":"app-fedramp-tracker","name":"FedRAMP Compliance Tracker","description":"Track FedRAMP control implementation across Loom-deployed services. Maps Synapse, Databricks, ADX, APIM, AI Foundry to NIST 800-53 controls.","icon":"ShieldCheckmark20Regular","category":"Compliance","publisher":"CSA","items":[{"type":"scorecard","template":"fedramp-controls"},{"type":"kql-dashboard","template":"compliance-events"}]},
  {"id":"app-data-steward","name":"Data Steward Console","description":"Curate datasets, manage classifications, certify endorsements. Wires Purview + AI Search + Synapse Serverless for lineage + search.","icon":"PersonStar20Regular","category":"Governance","publisher":"CSA","items":[{"type":"data-product","template":"steward-default"},{"type":"semantic-model","template":"steward-glossary"}]},
  {"id":"app-rag-builder","name":"RAG Builder","description":"Stand up a Retrieval-Augmented Generation pipeline. Builds an AI Search index, wires Foundry prompt-flow, deploys an evaluation suite.","icon":"BookSearch20Regular","category":"AI","publisher":"CSA","items":[{"type":"ai-search-index","template":"rag-default"},{"type":"prompt-flow","template":"rag-basic"},{"type":"evaluation","template":"rag-quality"}]},
  {"id":"app-lakehouse-inspector","name":"Lakehouse Inspector","description":"Browse bronze/silver/gold ADLS containers, preview Parquet/Delta files via Synapse Serverless, profile data quality.","icon":"DocumentDatabase20Regular","category":"Data","publisher":"CSA","items":[{"type":"lakehouse","template":"medallion"}]},
  {"id":"app-pipeline-designer","name":"Pipeline Designer","description":"Visual + JSON authoring for Synapse pipelines, ADF, Databricks Jobs. Common run history + alerting.","icon":"FlowchartCircle20Regular","category":"Data Engineering","publisher":"CSA","items":[{"type":"synapse-pipeline","template":"blank"},{"type":"adf-pipeline","template":"blank"},{"type":"databricks-job","template":"blank"}]},
  {"id":"app-casino-analytics","name":"Casino Analytics","description":"Reference architecture: player-grain facts, table games, real-time win/loss, Activator alerts for high-roller events.","icon":"GameChip20Regular","category":"Industry","publisher":"CSA","items":[{"type":"warehouse","template":"casino-dw"},{"type":"activator","template":"high-roller-alert"}]},
  {"id":"app-healthcare-popmgt","name":"Healthcare Population Health","description":"FHIR-on-Lakehouse + risk stratification model + Power BI patient dashboards. HIPAA-aligned.","icon":"HeartPulse20Regular","category":"Industry","publisher":"CSA","items":[{"type":"lakehouse","template":"fhir-medallion"},{"type":"ml-model","template":"risk-stratification"}]},
  {"id":"app-iot-realtime","name":"IoT Real-Time Insights","description":"IoT Hub → Event Hubs → ADX → KQL dashboards. Activator alerts on device anomalies. End-to-end in one workspace.","icon":"DataLine20Regular","category":"Real-Time","publisher":"CSA","items":[{"type":"eventstream","template":"iot-default"},{"type":"kql-database","template":"iot-telemetry"},{"type":"kql-dashboard","template":"device-health"}]},
  {"id":"app-finops-cost","name":"FinOps Cost Optimizer","description":"Per-domain chargeback report, Synapse pool auto-pause schedule, idle workload finder. Cosmos-backed budgets.","icon":"MoneyHand20Regular","category":"Operations","publisher":"CSA","items":[{"type":"semantic-model","template":"finops-cost"},{"type":"report","template":"finops-monthly"}]},
  {"id":"app-fabric-mirror-onboard","name":"Fabric Mirror Onboarding","description":"One-click setup for Fabric Mirroring: Azure SQL Mirror, Snowflake Mirror, Cosmos Mirror with target workspace + RBAC.","icon":"ArrowSwap20Regular","category":"Data","publisher":"CSA","items":[{"type":"mirrored-database","template":"azure-sql-mirror"}]},
  {"id":"change-feed-processor","name":"Change Feed Processor","description":"Event-driven sync on the Cosmos DB change feed: a Functions-hosted processor fans each change out to Event Hubs, AI Search, Redis, and Delta Lake. Ships the fan-out eventstream, processor + Delta-sync notebooks, orders lakehouse + AI Search index, and a change-feed-lag KQL DB + dashboard + Activator alert.","icon":"DatabaseArrowRight20Regular","category":"Real-Time","publisher":"CSA","items":[{"type":"eventstream","template":"order-change-fanout"},{"type":"notebook","template":"change-feed-processor"},{"type":"notebook","template":"delta-sync"},{"type":"lakehouse","template":"orders-delta"},{"type":"ai-search-index","template":"orders"},{"type":"kql-database","template":"change-feed-monitoring"},{"type":"kql-dashboard","template":"change-feed-health"},{"type":"activator","template":"change-feed-lag-alert"}]},
  {"id":"direct-lake-replacement","name":"Direct Lake-Replacement","description":"Migrate off a legacy BI server to Power BI Premium + a Loom lakehouse with 5-30s freshness via the Direct-Lake-Shim warm-cache materializer: Mirror to Bronze, Silver/Gold Databricks notebooks, Event Grid -> eventstream -> partition-refresh pipeline (TOM RequestRefresh), Import semantic model + report, and a freshness Activator watchdog.","icon":"ArrowSync20Regular","category":"Data","publisher":"CSA","items":[{"type":"mirrored-database","template":"legacy-sales-oltp"},{"type":"lakehouse","template":"direct-lake-replacement"},{"type":"databricks-notebook","template":"silver-cleanse"},{"type":"databricks-notebook","template":"gold-star-schema"},{"type":"eventstream","template":"gold-commit-shim"},{"type":"data-pipeline","template":"dl-shim-refresh"},{"type":"semantic-model","template":"sales-analytics-import"},{"type":"report","template":"sales-analytics"},{"type":"activator","template":"shim-freshness-watchdog"}]},
  {"id":"federal-data-mesh","name":"Federal Data Mesh","description":"A federal department running multiple agencies as autonomous data-product domains (per-DLZ subscriptions) federated under a Department-CIO governance plane. Seeds a cross-domain marketplace data product + AI Search catalog, Agency A domain lakehouse, Delta Sharing automation notebook, federated access register (warehouse), cross-agency semantic model + report, and a FederationAudit ADX DB + dashboard + Activator alert.","icon":"Organization20Regular","category":"Government","publisher":"CSA","items":[{"type":"data-product","template":"cross-domain-marketplace"},{"type":"lakehouse","template":"agency-a-domain"},{"type":"notebook","template":"cross-domain-delta-sharing"},{"type":"warehouse","template":"federated-access-register"},{"type":"semantic-model","template":"cross-agency-performance"},{"type":"report","template":"cross-agency-dashboards"},{"type":"kql-database","template":"federation-audit"},{"type":"kql-dashboard","template":"federation-cost"},{"type":"activator","template":"label-violation-alert"},{"type":"ai-search-index","template":"data-product-catalog"},{"type":"data-pipeline","template":"federation-sync"}]},
  {"id":"ml-pipeline","name":"ML Pipeline (MLOps)","description":"A complete customer-churn MLOps loop on Databricks + Azure ML: feature store, MLflow/XGBoost training registered to Unity Catalog, validation gate, Model Serving deployment, and Lakehouse-Monitoring drift detection. Seeds five notebooks, the churn lakehouse, monitoring warehouse, MLOps orchestration pipeline, and a model-drift Activator alert.","icon":"BrainCircuit20Regular","category":"AI","publisher":"CSA","items":[{"type":"lakehouse","template":"ml-churn"},{"type":"notebook","template":"feature-engineering"},{"type":"notebook","template":"model-training"},{"type":"notebook","template":"model-validation"},{"type":"notebook","template":"model-deployment"},{"type":"notebook","template":"model-monitoring"},{"type":"ml-model","template":"customer-churn"},{"type":"warehouse","template":"ml-monitoring"},{"type":"data-pipeline","template":"mlops-orchestration"},{"type":"activator","template":"model-drift-alert"}]},
  {"id":"multi-agency-onboarding","name":"Multi-Agency Onboarding","description":"The operational + governance analytics estate for onboarding additional agencies to a federal CSA Loom deployment as Data Landing Zones (DLZs) under a central Admin Plane. Seeds the DLZ Onboarding Registry (warehouse), the orchestrator notebook + provision/validate pipeline (PIM -> Bicep deploy -> peering check -> catalog scan -> smoke test), a federation-governance lakehouse, onboarding-telemetry KQL DB, governance semantic model + cockpit report, and a deployment-health Activator alert.","icon":"PeopleTeam20Regular","category":"Government","publisher":"CSA","items":[{"type":"warehouse","template":"dlz-onboarding-registry"},{"type":"notebook","template":"dlz-onboarding-orchestrator"},{"type":"data-pipeline","template":"dlz-provision-validate"},{"type":"lakehouse","template":"federation-governance"},{"type":"kql-database","template":"onboarding-telemetry"},{"type":"semantic-model","template":"federation-governance"},{"type":"report","template":"onboarding-cockpit"},{"type":"activator","template":"dlz-deployment-health"}]}
]
JSON
)

echo "$APPS" | jq -c '.[]' | while IFS= read -r app; do
  doc=$(echo "$app" | jq --arg t "$TENANT" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {tenantId:$t, createdBy:"csa-loom-seed", createdAt:$now, updatedAt:$now, installedBy:[]}')
  az cosmosdb sql container item create \
    --account-name "$COSMOS" -g "$DLZ_RG" -d "$DB" -c apps-catalog \
    --partition-key-value "$TENANT" --body "$doc" 2>/dev/null || \
  az cosmosdb sql container item replace \
    --account-name "$COSMOS" -g "$DLZ_RG" -d "$DB" -c apps-catalog \
    --partition-key-value "$TENANT" --item-id "$(echo "$app" | jq -r .id)" --body "$doc" >/dev/null || true
done
echo "  apps-catalog: 15 docs"

echo "==> Seeding workloads-catalog (10 included + 3 CSA-specific)..."
WORKLOADS=$(cat <<JSON
[
  {"id":"wl-data-engineering","name":"Data Engineering","description":"Synapse + ADF + Spark pools for ETL/ELT at scale.","category":"Included","included":true,"featureSlugs":["synapse-serverless-sql-pool","synapse-dedicated-sql-pool","synapse-spark-pool","synapse-pipeline","adf-pipeline","spark-job-definition","environment","copy-job"]},
  {"id":"wl-data-factory","name":"Data Factory","description":"ADF pipelines, triggers, datasets, mapping data flows.","category":"Included","included":true,"featureSlugs":["adf-pipeline","adf-dataset","adf-trigger"]},
  {"id":"wl-data-science","name":"Data Science","description":"AI Foundry hub, ML models + experiments, prompt flow, evaluations, compute clusters.","category":"Included","included":true,"featureSlugs":["ai-foundry-hub","ml-model","ml-experiment","prompt-flow","evaluation","compute","dataset"]},
  {"id":"wl-data-warehouse","name":"Data Warehouse","description":"Synapse Dedicated SQL pool (MPP T-SQL) with auto-pause + on-demand resume.","category":"Included","included":true,"featureSlugs":["synapse-dedicated-sql-pool","warehouse","azure-sql-server","azure-sql-database"]},
  {"id":"wl-databases","name":"Databases","description":"Azure SQL family, SQL Server 2025 features, Cosmos DB, Mirrored databases.","category":"Included","included":true,"featureSlugs":["azure-sql-database","azure-sql-managed-instance","sql-server-2025-vector-index","mirrored-database"]},
  {"id":"wl-industry","name":"Industry Solutions","description":"Pre-built reference architectures for Healthcare, Financial, Casino, IoT.","category":"Included","included":true,"featureSlugs":["data-product-template","data-product-instance"]},
  {"id":"wl-power-bi","name":"Power BI","description":"Semantic models, reports, dashboards, paginated reports, scorecards.","category":"Included","included":true,"featureSlugs":["semantic-model","report","dashboard","paginated-report","scorecard"]},
  {"id":"wl-realtime","name":"Real-Time Intelligence","description":"Event Hubs, Eventhouse, KQL databases + querysets + dashboards, Activator rules.","category":"Included","included":true,"featureSlugs":["eventhouse","kql-database","kql-queryset","kql-dashboard","eventstream","activator"]},
  {"id":"wl-power-platform","name":"Power Platform","description":"Environments, Dataverse, Power Apps, Power Automate, Power Pages, AI Builder.","category":"Included","included":true,"featureSlugs":["dataverse-table","power-app","power-automate-flow","power-page","ai-builder-model"]},
  {"id":"wl-copilot-studio","name":"Copilot Studio","description":"Agents, knowledge sources, topics, actions, channels, analytics, CSA template library.","category":"Included","included":true,"featureSlugs":["copilot-studio-agent","copilot-studio-knowledge","copilot-studio-topic","copilot-studio-action","copilot-studio-channel","copilot-studio-analytics","copilot-template-library"]},
  {"id":"wl-csa-fedramp","name":"FedRAMP Compliance Engine","description":"NIST 800-53 control mapping + continuous audit telemetry + IL5 deployment variant.","category":"CSA","included":false,"featureSlugs":["scorecard","kql-dashboard","activator"]},
  {"id":"wl-csa-geoanalytics","name":"Geoanalytics","description":"H3/S2 spatial indexing, ST_* functions over Lakehouse, Azure Maps integration.","category":"CSA","included":false,"featureSlugs":["geo-map","geo-dataset","geo-query","geo-pipeline"]},
  {"id":"wl-csa-graph","name":"Graph + Vector","description":"Cosmos Gremlin, Cypher (via ADX make-graph), GQL, vector store across Cosmos/AI Search/pgvector.","category":"CSA","included":false,"featureSlugs":["cosmos-gremlin-graph","cypher-graph","gql-graph","vector-store"]}
]
JSON
)

echo "$WORKLOADS" | jq -c '.[]' | while IFS= read -r wl; do
  doc=$(echo "$wl" | jq --arg t "$TENANT" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {tenantId:$t, publisher:"CSA", iconUrl:null, createdBy:"csa-loom-seed", createdAt:$now, updatedAt:$now}')
  az cosmosdb sql container item create \
    --account-name "$COSMOS" -g "$DLZ_RG" -d "$DB" -c workloads-catalog \
    --partition-key-value "$TENANT" --body "$doc" 2>/dev/null || \
  az cosmosdb sql container item replace \
    --account-name "$COSMOS" -g "$DLZ_RG" -d "$DB" -c workloads-catalog \
    --partition-key-value "$TENANT" --item-id "$(echo "$wl" | jq -r .id)" --body "$doc" >/dev/null || true
done
echo "  workloads-catalog: 13 docs"

echo ""
echo "DONE. apps-catalog + workloads-catalog seeded under tenant '$TENANT'."
echo "The BFF reads against session.claims.oid; for tenants without seed data,"
echo "the per-user '/api/apps-catalog' returns []. Each tenant gets seed copies"
echo "on first sign-in via the auto-copy seam in app-shell.tsx (Chunk 1)."
