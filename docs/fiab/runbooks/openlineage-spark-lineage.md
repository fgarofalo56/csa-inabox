# OpenLineage Spark column lineage — setup, rotation, threat model (L2)

CSA Loom captures **declared column-level lineage from Synapse Spark jobs** via
the [openlineage-spark](https://openlineage.io/docs/integrations/spark/)
listener: every `COMPLETE` RunEvent's `columnLineage` facet is ingested into
the L1 column model (`ThreadEdge.columnMappings`, `confidence:'declared'`) and
renders on the unified lineage canvas (`GET /api/catalog/lineage?…&columns=true`).
Azure-native end to end — no Fabric, no Purview requirement (Purview mirroring
remains the separate best-effort overlay).

## Architecture

```
Synapse Spark pool (loompool / loometl / loombatch)
  spark.extraListeners = io.openlineage.spark.agent.OpenLineageSparkListener
  spark.openlineage.transport.type = http
  spark.openlineage.transport.url  = https://loom-console.<cae-domain>/api/lineage/openlineage   (IN-VNET)
  spark.openlineage.transport.auth = per-pool credential (minted, rotated — see below)
        │  OpenLineage RunEvent (COMPLETE, columnLineage facet)
        ▼
POST /api/lineage/openlineage  (in-VNet ingress ONLY; public-FD path rejected 403)
  → verify credential (lib/azure/openlineage-auth.ts)
  → map facet → RecordEdgeInput.columnMappings (lib/azure/openlineage-ingest.ts — pure)
  → resolve abfss dataset URIs → Loom items (state storage paths, longest prefix)
  → WORKSPACE-SCOPE assert (cross-workspace → 403 + audit row)
  → recordThreadEdge (Cosmos thread-edges; upsert = idempotent per run/action)
```

## One-time pool config (the honest gate)

The listener is **NOT live until the operator applies pool config** — until
then the OpenLineage source is silently absent while the other column sources
(Databricks UC, dbt, ADF Copy mappings) keep flowing (default-ON preserved;
gate `svc-openlineage`, Fix-it wizard on the Admin gate-registry page).

```bash
LOOM_SYNAPSE_WORKSPACE=syn-loom-<domain>-<region> \
LOOM_SYNAPSE_RG=<dlz-rg> \
LOOM_SPARK_POOL=loompool \
LOOM_ADMIN_RG=<admin-rg> \
LOOM_OPENLINEAGE_ENDPOINT=https://loom-console.<cae-default-domain>/api/lineage/openlineage \
LOOM_WORKSPACE_ID=<loom-workspace-guid> \
  ./scripts/csa-loom/openlineage-pool-setup.sh          # default: workspace-token mode
```

What it does: uploads the `openlineage-spark` jar as a Synapse **workspace
library** (required — DEP-enabled workspaces cannot pull from public repos;
supply `OPENLINEAGE_JAR=<path>` on air-gapped estates), adds it to the pool,
mints the credential, registers it on the Console, and stamps the pool's
Spark configuration (merged with the baked best-practice conf from
`modules/landing-zone/synapse-spark-pools.bicep` — the bicep bag
`openLineageConfig` can pre-bake the secret-free transport lines; the
credential is never in bicep). New Spark sessions pick the listener up.

## Auth modes (rev-2 SRE-F2 redesign — binding)

Never one global static secret. `LOOM_OPENLINEAGE_AUTH_MODE` selects:

| Mode | Credential | Workspace binding | Pairs with |
|------|-----------|-------------------|-----------|
| `workspace-token` (script default) | Per-**workspace** random 256-bit token, ACA secret `loom-openlineage-token` (`LOOM_OPENLINEAGE_WORKSPACE_TOKEN` secretRef), constant-time compare | The token IS the binding (`<workspaceId>=<token>`) | Stock openlineage-spark http transport `auth.type=api_key` |
| `entra` (env default) | Per-**pool** AAD app registration; ingest validates the bearer JWT — JWKS signature, RS256, issuer pinned to the estate tenant (Commercial `login.microsoftonline.com` / Gov `login.microsoftonline.us` + `sts.windows.net`), audience pinned to the console app registration | `LOOM_OPENLINEAGE_POOL_PRINCIPALS` = `appId=workspaceId` pairs | Listener builds with an AAD client-credential token provider; any AAD-capable producer (e.g. the L3 extractor, CI fixtures) |

### Rotation runbook

- **workspace-token:** re-run `openlineage-pool-setup.sh` — it mints a fresh
  token, replaces the ACA secret atomically, and restamps the pool conf. Old
  token dies with the secret update (next revision). Rotate at least quarterly
  and on any suspected exposure. The S1 secret-expiry inventory tracks the
  app-registration secrets used in entra mode.
- **entra:** `az ad app credential reset --id <pool-app-id>` and update the
  listener's token-provider secret; the console-side registration
  (`appId=workspaceId`) is credential-independent and needs no change.

## Enforced limits (route: `app/api/lineage/openlineage/route.ts`)

- Body cap **5 MB** (mirror of the eventhouse ingest byte cap) → `413`
- Per-credential rate limit (in-proc token bucket 5 rps / burst 20 + durable
  cross-replica Cosmos window) → `429`
- Dataset fan-out ≤ 50 / RunEvent; **columnMappings fan-out ≤ 500** / RunEvent
  (Cosmos write-amplification guard) → `413`
- Public Front Door path (`x-azure-fdid` present) → `403` (in-VNet only;
  `LOOM_OPENLINEAGE_PUBLIC_INGRESS_ENABLED=true` is an explicit break-glass
  opt-out, not a supported posture)
- Cross-workspace resolved output → `403` + authoritative `_auditLog` row
  (`lineage.openlineage.cross-workspace-denied`) + SIEM `emitAuditEvent`

## Threat model — STRIDE row (signed in the L2 PR; cross-referenced by I9)

| STRIDE | Threat (OL ingest) | Mitigation (shipped in L2) |
|--------|--------------------|----------------------------|
| **S**poofing | Forged producer posts lineage as another pool/workspace | Per-pool Entra bearer (JWKS sig, tenant + audience pinned) or per-workspace minted token; fail-closed (unset → 503, bad → 401, unregistered principal → 403) |
| **T**ampering | Attacker writes false provenance edges into a victim workspace (SI-7/SC-8 integrity) | Credential → ONE workspace binding; every resolved output item asserted in-workspace; cross-workspace write → 403 + audit; unresolved datasets skipped (never fabricated nodes) |
| **R**epudiation | Ingest writes not attributable | Machine identity stamped on every edge (`createdBy: openlineage-ingest@loom.internal`, `action: 'openlineage-spark'`); denials write `_auditLog` + SIEM rows (principal, scopes, target URI, ts) |
| **I**nfo disclosure | Lineage endpoint enumerable from the internet; token leak via pool config | In-VNet ingress only + in-code FD-path rejection; workspace-token grants ONE workspace's lineage-write only (blast radius bounded); secret lives in an ACA secretRef, not plaintext env; rotation runbook above |
| **D**oS | Event floods / giant RunEvents exhaust Cosmos RU or console CPU | 5 MB byte cap, 50-dataset + 500-columnMapping fan-out caps, two-tier per-credential rate limit; writes are bounded upserts (idempotent per run/action) |
| **E**levation | Ingest credential reused against user APIs | The credential is honored by exactly one route; it is not a session, PAT, or internal trust token (separate verifier, separate env), and the route grants no read surface |

## Per-cloud

- **Commercial:** live. The console's default topology is fronted by public
  Front Door — "in-cluster" is NOT automatic, so the pool is stamped with the
  **CAE default-domain (in-VNet) URL** and the route rejects the FD path.
- **Gov (GCC-High):** live — Synapse Spark pools + workspace libraries are GA
  in Azure Government; same in-VNet-only binding; AAD hosts flip to
  `login.microsoftonline.us` automatically (`AZURE_CLOUD=AzureUSGovernment`).
- **IL5:** design-constraint documentation only — DEP workspace: the listener
  jar MUST be uploaded as a workspace library from an in-boundary artifact
  store (`OPENLINEAGE_JAR=<path>`; no public Maven egress); ingest reachable
  over the private ingress/PE only, per the X-IL5 checklist. Cost ~$0 idle
  (listener runs inside existing Spark sessions; ingest is the existing
  console).

## LU-8 — Loom-side emitters (Synapse pipeline + Spark batch), no operator setup

The listener above is the HIGHEST-fidelity source (it sees the physical plan, so
it emits true column lineage). It is not the only one. LU-8 adds two emitters
that run **inside the console** and need no pool config at all, so a merged
lineage graph exists on day one:

| Emitter | Trigger (real backend read) | Event | ThreadEdge `action` |
|---------|-----------------------------|-------|---------------------|
| **Synapse / ADF pipeline** | `GET /api/items/data-pipeline/[id]/jobs` (newest Succeeded run) and `…/output?runId=` — reads the pipeline definition, its datasets + linked services, and `queryActivityRuns` | one `RunEvent` per lineage-bearing **activity** (`job.name = <pipeline>.<activity>`), Copy `translator.mappings` → `columnLineage` facet | `openlineage-pipeline` |
| **Synapse Spark batch** | `GET /api/items/spark-job-definition/[id]/runs/[runId]` — reads the Livy batch's own `livyInfo.jobCreationRequest` (the args + conf Loom submitted). No fallback to the item's stored draft: a draft edited after the run would attribute a fabricated edge to a real run. Only a batch whose Livy `name` carries this item's `loom-<name>-` submit prefix is harvested (Livy ids are pool-scoped). | one `RunEvent` per batch; datasets from `spark.loom.lineage.inputs/outputs` conf or `--input`/`--output` argv | `openlineage-spark` |

Both build spec-valid OpenLineage 1.x `RunEvent`s (`lib/lineage/synapse-emitters.ts`,
pure) and write them through the **same L2 sink** — `mapRunEventToEdges` →
`recordThreadEdge` (`lib/lineage/synapse-lineage-harvest.ts`). No second store,
no second mapper. Note the partition difference: the listener ingest is a
machine path and writes with `machineSession(ws.tenantId)` (the workspace
OWNER's partition); the harvests run inside an authenticated request and write
with the caller's session. `run.runId` is a deterministic UUIDv5 of the run's
natural key — which includes the submit time for a Spark batch, because Livy
batch ids restart from 0 when a pool is recreated — so re-harvesting is
idempotent for downstream OL consumers too. Only a **succeeded** run/activity
emits `COMPLETE`; anything else maps to `FAIL`/`ABORT`, which the mapper drops —
a failed copy never stamps lineage, and an UNKNOWN run status is treated as
not-succeeded rather than skipping the gate.

Honest limits (no fabrication): a Spark batch whose IO is not in its conf/argv
emits nothing and returns a reason naming the listener; an ADF dataset that
cannot be anchored to a physical location is skipped rather than rendered as an
un-joinable node.

### Canonical dataset naming (`lib/lineage/dataset-naming.ts`)

This is the part that makes the graph actually merge. The same ADLS folder is
spelled at least four ways across producers (`abfss://c@a.dfs…`, `wasbs://`, the
ADF `fileSystem` + `folderPath` on an `https://a.dfs…` linked service, and a
Spark write that names `…/_delta_log`). All of them reduce to ONE canonical
identity, per the [OpenLineage naming spec](https://openlineage.io/docs/spec/naming)
(docs release 1.52.0; RunEvent schema pinned to `1-0-5`):

- **ADLS Gen2 / Blob** → namespace `abfss://{container}@{account}.dfs.{suffix}`,
  name `/{path}`. `wasbs`/`abfs`/`https` dfs+blob spellings all fold in (one
  storage account + container + path is one dataset), `_delta_log` /
  `_spark_metadata` / part-file leaves fold onto the table folder, and the
  identity is case-folded. Sovereign suffixes are carried through, never assumed.
- **Synapse / SQL** → the OpenLineage dataset is namespace
  `sqlserver://{host}:{port}` + name `{database}.{schema}.{table}`, and the
  identity **persisted on the thread edge** is the bare 3-part
  `{database}.{schema}.{table}` (`canonicalDatasetIdentity()`). That is the only
  spelling `normalizeIdentity` turns into a `uc:` key, so the SQL sink collapses
  onto the node the Unity Catalog overlay and the dbt L6 parser
  (`physicalRelation()`, identical 3-part form) contribute. Persisting the full
  `sqlserver://…` URI instead — as the first cut of LU-8 did — yields a node
  that normalizes to itself and joins to nothing.

### Security properties of a dataset identity

A dataset identity is **persisted** (thread edge, Cosmos document id, graph node
id) and **rendered** (canvas node label), so it is treated as untrusted input:

- `stripUriCredentials()` removes the query string (SAS `?sv=…&sig=…`) and URI
  userinfo before parsing, and the account/container slots are charset-validated
  so a `user:pass@host` pair cannot be captured as an account name. Nothing
  reaches the store with a signature in it — asserted end-to-end in
  `lib/lineage/__tests__/lineage-security.test.ts`.
- An item's stored state path is canonicalized **without** the table-folder fold
  (`{ fold: false }`): folding an ownership CLAIM widens it to the parent folder,
  and a resolved local owner suppresses the cross-workspace forgery probe.
- Both producers run the same `findForeignOwner` probe. A dataset owned by an
  item in another workspace is refused (never written, never labelled) and the
  denial is audited (`lineage.cross-workspace-denied`); harvest writes are
  audited too (`lineage.harvested`).
- Caller-supplied run identifiers are validated before they drive a write: an
  ADF `?runId=` must belong to the item's own `adfPipelineName`
  (`getPipelineRun`), and a Livy `batchId` — which is POOL-scoped, not
  item-scoped — must carry this item's submit-name prefix.

Three joins were repaired by adopting it:

1. `POST /api/lineage/openlineage` matched dataset URIs against item state paths
   **verbatim** — an item whose `state.adlsRoot` held the `https://…` spelling
   could never be matched by a Spark event, so those events were silently
   skipped. Both sides are now canonicalized (`lib/lineage/dataset-item-resolver.ts`,
   shared by all three producers).
2. Weave/thread-edge endpoints only carried an `item:<id>` identity, so an edge
   recorded against a physical path or a `catalog.schema.table` relation (the
   emitters, and the dbt L6 parser) could never collapse onto the Purview /
   Unity Catalog node for the same asset.
3. The Purview overlay derived its join key from `displayText` (usually just the
   leaf name) and ignored the Atlas **qualifiedName** — the actual FQN.

## MIG1 note (Cosmos doc shapes)

No migration required: `ThreadEdge.columnMappings` is **additive** and shipped
in L1 (#2403) — pre-existing table-grain edges keep their exact stored shape
(the field is only persisted when present), and `migrateOnRead` has nothing to
upgrade. L2 only writes NEW edges in the L1 shape.

## Verification

- Unit (LU-8): `lib/lineage/__tests__/dataset-naming.test.ts` (spelling
  equivalences + the non-equivalences), `…/synapse-emitters.test.ts` (RunEvent
  conformance, status→eventType, translator → columnLineage) and
  `…/lineage-join.test.ts` — **the join proof**: it emits from BOTH sides over
  the same folders (Spark by `…/_delta_log` argv, the pipeline by
  fileSystem+folderPath on an https linked service) and asserts the real merge
  engine renders ONE connected `bronze → silver → gold` chain that also collapses
  with the Purview node for the same path. Negative/attack coverage lives in
  `…/lineage-security.test.ts` (SAS + userinfo stripping end-to-end,
  cross-workspace denial for BOTH producers, ownership-claim widening,
  unattributed Livy batch, unknown-run-status gate, dedupe-after-failure) and
  `lib/thread/__tests__/thread-edge-doc-id.test.ts` (id collision + 255-byte
  limit).
- Unit: `lib/azure/__tests__/openlineage-ingest.test.ts` (golden RunEvent →
  declared column mappings; fan-out caps) and
  `lib/azure/__tests__/openlineage-auth.test.ts` (real-RS256 accept path;
  expired / foreign-tenant / bad-audience / forged-signature / unregistered-
  principal rejections; workspace-token binding + fail-closed).
- Post-roll live receipt (orchestrator): POST the golden fixture with a minted
  workspace token against the live in-VNet route → `200 {ok:true, accepted…}`,
  then read the edges back via `GET /api/catalog/lineage?…&columns=true`; a
  curl from OUTSIDE the VNet (public FD host) must NOT reach the route.
