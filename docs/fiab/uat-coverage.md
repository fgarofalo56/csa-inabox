# CSA Loom — UAT Coverage Matrix

> Auto-generated from `apps/fiab-console/test-results/uat/verdicts.ndjson` on 2026-05-26T13:58:20Z.
> Last run: v3.18 against https://<your-console-hostname>

## Grading rubric

- **A** — renders cleanly, all backend calls succeed (real data flowing)
- **B** — renders cleanly, some calls hit documented "not configured in this env" gates (e.g. Power Platform Default env without Copilot Studio)
- **C** — renders, but has unexpected console or network errors that need investigation
- **D** — renders but every interactive action is fake or wrong
- **F** — crashes on load, or is pure vaporware (placeholder only)

## Roll-up

| Family | Total | A | B | C | D | F |
|---|---:|---:|---:|---:|---:|---:|
| app | 10 | 10 | 0 | 0 | 0 | 0 |
| editor | 85 | 59 | 26 | 0 | 0 | 0 |
| page | 18 | 18 | 0 | 0 | 0 | 0 |

## Detail

### app

| Surface | Verdict | Status | Notes |
|---|:---:|---|---|
| app\:app-casino-analytics | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-data-steward | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-fabric-mirror-onboard | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-fedramp-tracker | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-finops-cost | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-healthcare-popmgt | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-iot-realtime | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-lakehouse-inspector | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-pipeline-designer | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |
| app\:app-rag-builder | A | vaporware | created=0 existed=0 failed=0, detail page renderOk=true |

### editor

| Surface | Verdict | Status | Notes |
|---|:---:|---|---|
| editor\:activator | A | pass | renders cleanly, real backend responded |
| editor\:adf-dataset | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:adf-pipeline | B | pass | renders cleanly; 2 documented "not configured in this env" gates |
| editor\:adf-trigger | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:ai-builder-model | B | pass | renders cleanly; 2 documented "not configured in this env" gates |
| editor\:ai-foundry-hub | A | pass | renders cleanly, real backend responded |
| editor\:ai-foundry-project | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:ai-search-index | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:apim-api | B | pass | renders cleanly; 2 documented "not configured in this env" gates |
| editor\:apim-policy | A | pass | renders cleanly, real backend responded |
| editor\:apim-product | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:azure-sql-database | A | pass | renders cleanly, real backend responded |
| editor\:azure-sql-managed-instance | A | pass | renders cleanly, real backend responded |
| editor\:azure-sql-server | A | pass | renders cleanly, real backend responded |
| editor\:compute | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:content-safety | A | pass | renders cleanly, real backend responded |
| editor\:copilot-studio-action | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-studio-agent | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-studio-analytics | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-studio-channel | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-studio-knowledge | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-studio-topic | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:copilot-template-library | A | pass | renders cleanly, real backend responded |
| editor\:copy-job | A | pass | renders cleanly, real backend responded |
| editor\:cosmos-gremlin-graph | A | pass | renders cleanly, real backend responded |
| editor\:cross-item-copilot | A | pass | renders cleanly, real backend responded |
| editor\:cypher-graph | A | pass | renders cleanly, real backend responded |
| editor\:dashboard | A | pass | renders cleanly, real backend responded |
| editor\:data-agent | A | pass | renders cleanly, real backend responded |
| editor\:data-pipeline | A | pass | renders cleanly, real backend responded |
| editor\:data-product | A | pass | renders cleanly, real backend responded |
| editor\:data-product-instance | A | pass | renders cleanly, real backend responded |
| editor\:data-product-template | A | pass | renders cleanly, real backend responded |
| editor\:databricks-cluster | A | pass | renders cleanly, real backend responded |
| editor\:databricks-job | A | pass | renders cleanly, real backend responded |
| editor\:databricks-notebook | A | pass | renders cleanly, real backend responded |
| editor\:databricks-sql-warehouse | A | pass | renders cleanly, real backend responded |
| editor\:dataflow | A | pass | renders cleanly, real backend responded |
| editor\:dataset | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:dataverse-table | B | pass | renders cleanly; 2 documented "not configured in this env" gates |
| editor\:dbt-job | A | pass | renders cleanly, real backend responded |
| editor\:environment | A | pass | renders cleanly, real backend responded |
| editor\:evaluation | A | pass | renders cleanly, real backend responded |
| editor\:eventhouse | A | pass | renders cleanly, real backend responded |
| editor\:eventstream | A | pass | renders cleanly, real backend responded |
| editor\:geo-dataset | A | pass | renders cleanly, real backend responded |
| editor\:geo-map | A | pass | renders cleanly, real backend responded |
| editor\:geo-pipeline | A | pass | renders cleanly, real backend responded |
| editor\:geo-query | A | pass | renders cleanly, real backend responded |
| editor\:gql-graph | A | pass | renders cleanly, real backend responded |
| editor\:graph-model | A | pass | renders cleanly, real backend responded |
| editor\:graphql-api | A | pass | renders cleanly, real backend responded |
| editor\:kql-dashboard | A | pass | renders cleanly, real backend responded |
| editor\:kql-database | A | pass | renders cleanly, real backend responded |
| editor\:kql-queryset | A | pass | renders cleanly, real backend responded |
| editor\:lakehouse | A | pass | renders cleanly, real backend responded |
| editor\:map | A | pass | renders cleanly, real backend responded |
| editor\:mirrored-database | A | pass | renders cleanly, real backend responded |
| editor\:ml-experiment | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:ml-model | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:notebook | A | pass | renders cleanly, real backend responded |
| editor\:ontology | A | pass | renders cleanly, real backend responded |
| editor\:operations-agent | A | pass | renders cleanly, real backend responded |
| editor\:paginated-report | A | pass | renders cleanly, real backend responded |
| editor\:plan | A | pass | renders cleanly, real backend responded |
| editor\:power-app | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:power-automate-flow | B | pass | renders cleanly; 3 documented "not configured in this env" gates |
| editor\:power-page | B | pass | renders cleanly; 2 documented "not configured in this env" gates |
| editor\:powerplatform-environment | A | pass | renders cleanly, real backend responded |
| editor\:prompt-flow | A | pass | renders cleanly, real backend responded |
| editor\:report | A | pass | renders cleanly, real backend responded |
| editor\:scorecard | A | pass | renders cleanly, real backend responded |
| editor\:semantic-model | A | pass | renders cleanly, real backend responded |
| editor\:spark-job-definition | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:sql-server-2025-vector-index | A | pass | renders cleanly, real backend responded |
| editor\:synapse-dedicated-sql-pool | A | pass | renders cleanly, real backend responded |
| editor\:synapse-pipeline | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:synapse-serverless-sql-pool | A | pass | renders cleanly, real backend responded |
| editor\:synapse-spark-pool | B | pass | renders cleanly; 1 documented "not configured in this env" gates |
| editor\:tracing | A | pass | renders cleanly, real backend responded |
| editor\:user-data-function | A | pass | renders cleanly, real backend responded |
| editor\:usql-job | A | pass | renders cleanly, real backend responded |
| editor\:variable-library | A | pass | renders cleanly, real backend responded |
| editor\:vector-store | A | pass | renders cleanly, real backend responded |
| editor\:warehouse | B | pass | renders cleanly; 1 documented "not configured in this env" gates |

### page

| Surface | Verdict | Status | Notes |
|---|:---:|---|---|
| page\:/ | A | pass | 4263 chars rendered |
| page\:/admin | A | pass | 2489 chars rendered |
| page\:/api-marketplace | A | pass | 1801 chars rendered |
| page\:/apps | A | pass | 10 apps in catalog |
| page\:/apps | A | pass | 3012 chars rendered |
| page\:/browse | A | pass | 1687 chars rendered |
| page\:/copilot | A | pass | 1887 chars rendered |
| page\:/data-agent | A | pass | 1765 chars rendered |
| page\:/deployment-pipelines | A | pass | 1817 chars rendered |
| page\:/governance | A | pass | 1972 chars rendered |
| page\:/learn | A | pass | 15158 chars rendered |
| page\:/monitor | A | pass | 2004 chars rendered |
| page\:/onelake | A | pass | 1661 chars rendered |
| page\:/realtime-hub | A | pass | 1798 chars rendered |
| page\:/setup | A | pass | 1808 chars rendered |
| page\:/workload-hub | A | pass | 3841 chars rendered |
| page\:/workloads | A | pass | 3841 chars rendered |
| page\:/workspaces | A | pass | 1710 chars rendered |