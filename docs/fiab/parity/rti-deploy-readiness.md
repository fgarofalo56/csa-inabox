# RTI (Real-Time Intelligence) — deploy-readiness wiring

**Scope:** Event Hubs, Azure Data Explorer (ADX/Kusto), Stream Analytics — the
Azure-native backends of the Loom RTI editor family (Eventstream, KQL Database /
Eventhouse, KQL Queryset, KQL Dashboard, stream-analytics-job, Data Explorer
receive, Mirroring CDC transport). Per `no-fabric-dependency.md` these are the
**default** backends — no Fabric/RTI capacity required.

This doc records what the **default deploy** provisions + wires so every RTI
editor's primary action works on first login (deploy-readiness PRP
`docs/fiab/prp/deploy-readiness-100pct.md`). Each backend is **ON by default
(opt-out)** behind a `loom<Svc>Enabled` flag; each is reusable via an `existing*`
param (scan-and-choose).

## Opt-out flags + existing-reuse (main.bicep)

| Backend | Enable flag (default) | Reuse-existing param | Provisioned where |
|---|---|---|---|
| Event Hubs namespace | `loomEventHubEnabled = true` | `existingEventHubNamespace` (+`Rg`/`Sub`) | per-DLZ `modules/landing-zone/eventhubs.bicep` |
| ADX shared cluster | `adxEnabled = true` | `existingAdxClusterName` (+`Rg`/`Sub`) | admin-plane `modules/admin-plane/adx-cluster.bicep` |
| Per-domain ADX DB | follows `adxEnabled` (single-sub); runtime for dlz-attach/tenant | n/a | `modules/landing-zone/adx.bicep` or `scripts/csa-loom/ensure-domain-adx-db.sh` |
| Stream Analytics job | `loomStreamAnalyticsEnabled = true` | `existingAsaJob` (+`Rg`/`Sub`) | per-DLZ `modules/landing-zone/stream-analytics.bicep` |
| IoT Hub | none (user-selected at runtime, by design) | `loomIotHubResourceId` | not provisioned (honest gate) |

Disabling sets the matching Console env empty → the navigator/editor shows an
honest Fluent `MessageBar` (`no-vaporware.md`), never a crash.

## Env wired by default (admin-plane → Console)

| Env var | Source | Notes |
|---|---|---|
| `LOOM_EVENTHUB_NAMESPACE` | `evhns-loom-default-<region>` when `loomEventHubEnabled`; else empty / reused name | Eventstream + Data Explorer receive |
| `LOOM_ASA_RG` | DLZ RG (single-sub) when `loomStreamAnalyticsEnabled`; reused job's RG; else empty | **G1 fix** — was empty → 501 |
| `NEXT_PUBLIC_LOOM_ASA_JOB_NAME` | `asa-loom-default-<region>` or reused job | starter job name |
| `LOOM_KUSTO_CLUSTER_URI/_DM_URI/_NAME/_RG/_SUB/_DEFAULT_DB` | adx-cluster outputs / existing cluster | `LOOM_KUSTO_DEFAULT_DB=loomdb-default` |
| `LOOM_IOT_HUB_RESOURCE_ID` | `loomIotHubResourceId` (empty by default) | runtime hub selection otherwise |

`patch-navigator-env.sh` reconciles `LOOM_ASA_RG` / `NEXT_PUBLIC_LOOM_ASA_JOB_NAME`
+ Event Hubs + `LOOM_KUSTO_DEFAULT_DB` for multi-sub / post-deploy without a redeploy.

## Role grants (all GUIDs cloud-agnostic — identical Commercial / GCC / GCC-High / IL5)

| Role | GUID | Grantee | Scope | Module |
|---|---|---|---|---|
| Stream Analytics **Query Tester** | `1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf` | Console UAMI | **subscription** | `admin-plane/asa-query-tester-rbac.bicep` (**G2 — new**) |
| Stream Analytics Contributor | `6e0c8711-85a0-4490-8365-8ec13c4560b4` | Console UAMI | DLZ RG | `landing-zone/stream-analytics.bicep` |
| Azure Event Hubs Data Owner | `f526a384-b230-433a-b45c-95f59c4a2dec` | Console UAMI | EH namespace | `landing-zone/eventhubs.bicep` |
| Contributor (namespace) | `b24988ac-6180-42a0-ab88-20f7382dd24c` | Console UAMI | EH namespace | `landing-zone/eventhubs.bicep` |
| Azure Event Hubs Data Receiver | `a638d3c7-ab3a-418d-83e6-5f17a39d4fde` | Console UAMI + ADX cluster MI | EH namespace | `landing-zone/eventhubs.bicep` |
| Azure Event Hubs Data Sender | `2b629674-e913-4c01-ae53-ef4638d8f975` | ADF factory MI | EH namespace | `landing-zone/eventhubs.bicep` |
| Schema Registry Contributor | `5dffeca3-4936-4216-b2bc-10343a5abb25` | Console UAMI | EH namespace | `landing-zone/eventhubs.bicep` |
| Monitoring Contributor | `749f88d5-c17c-40d2-a795-7d4f4a02e6a4` | Console UAMI | ADX cluster | `admin-plane/adx-cluster.bicep` |
| Storage Blob Data Contributor | `ba92f5b4-2d11-453d-a403-e96b0029c9fe` | ASA job MI | DLZ ADLS | `landing-zone/stream-analytics.bicep` |
| Reader (RTI hub discovery) | `acdd72a7-3385-48ef-bd42-f606fba81ae7` | Console UAMI | subscription | `admin-plane/rti-hub-rbac.bicep` |
| IoT Hub Contributor | `4763167e-fb37-48bb-8710-0fcd9d82e439` | ADX cluster MI | IoT Hub | operator-manual (runtime hub) — honest gate |

ADX also holds an `AllDatabasesAdmin` Kusto principal assignment for the Console
UAMI (adx-cluster.bicep), so per-domain DB grants are not needed for the Console.

## Why each control works first-try

- **Eventstream sources / Data Explorer receive** — EH namespace + `loom-telemetry`
  hub + `loom-receiver` group + Data Receiver grants (ADX MI + Console) + PE/DNS.
- **stream-analytics-job editor / Eventstream transform Compile** — `LOOM_ASA_RG`
  populated (G1) + Query Tester at sub scope (G2) authorizes
  `CompileQuery/TestQuery/SampleInput`.
- **KQL Database / Eventhouse / Queryset / Dashboard** — ADX cluster on by default
  with full Console RBAC + `loomdb-default` (single-sub) or
  `ensure-domain-adx-db.sh` (dlz-attach/tenant).
- **Run sample-output (ASA Test)** — needs a blob write-SAS target
  (`LOOM_ASA_TEST_WRITE_URI`); honest infra-gate until set (Compile stays
  functional). The Console UAMI already holds Storage Blob Data Contributor on the
  DLZ ADLS to mint one at runtime.

## Scan-and-choose coverage

- `scripts/csa-loom/discover-services.sh` — scans Event Hubs, ADX/Kusto,
  **Stream Analytics**, **IoT Hub**.
- `scripts/csa-loom/byo-wizard.sh` — Event Hubs (use-existing/new/disable via
  `loomEventHubEnabled`), ADX, **Stream Analytics** (`loomStreamAnalyticsEnabled`).
- Setup Wizard (`app/api/setup/deploy`) — RTI named toggles
  (`loomEventHubEnabled`, `existingEventHubNamespace`, `loomStreamAnalyticsEnabled`,
  `existingAsaJob`, `adxEnabled`, `existingAdxClusterName`) forwarded to the same
  main.bicep params the CLI writes.

## Verification

`az bicep build --file platform/fiab/bicep/main.bicep` — error-free for these
changes (the pre-existing admin-plane `max-params` linter note is unrelated). A
clean default deploy with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset must light up
every RTI editor's primary action against the provisioned Azure backends.
