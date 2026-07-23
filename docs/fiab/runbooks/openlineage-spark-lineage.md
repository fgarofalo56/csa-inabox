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

## MIG1 note (Cosmos doc shapes)

No migration required: `ThreadEdge.columnMappings` is **additive** and shipped
in L1 (#2403) — pre-existing table-grain edges keep their exact stored shape
(the field is only persisted when present), and `migrateOnRead` has nothing to
upgrade. L2 only writes NEW edges in the L1 shape.

## Verification

- Unit: `lib/azure/__tests__/openlineage-ingest.test.ts` (golden RunEvent →
  declared column mappings; fan-out caps) and
  `lib/azure/__tests__/openlineage-auth.test.ts` (real-RS256 accept path;
  expired / foreign-tenant / bad-audience / forged-signature / unregistered-
  principal rejections; workspace-token binding + fail-closed).
- Post-roll live receipt (orchestrator): POST the golden fixture with a minted
  workspace token against the live in-VNet route → `200 {ok:true, accepted…}`,
  then read the edges back via `GET /api/catalog/lineage?…&columns=true`; a
  curl from OUTSIDE the VNet (public FD host) must NOT reach the route.
