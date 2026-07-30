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

## LU-8a — ONE canonical dataset identity for every OpenLineage producer

The listener above is the HIGHEST-fidelity source (it sees the physical plan, so
it emits true column lineage). It has never been the only writer of the lineage
store, and it is about to stop being the only *producer*: the Synapse pipeline /
Spark batch emitters are the next PR. Everything below is the shared
read/identity layer they and the existing ingest route both go through, landed on
its own so it can be reviewed on its own.

### Canonical dataset naming (`lib/lineage/dataset-naming.ts`)

This is the part that makes the graph actually merge. The same ADLS folder is
spelled at least four ways across producers (`abfss://c@a.dfs…`, `wasbs://`, the
ADF `fileSystem` + `folderPath` on an `https://a.dfs…` linked service, and a
Spark write that names `…/_delta_log`). All of them reduce to ONE canonical
identity, per the [OpenLineage naming spec](https://openlineage.io/docs/spec/naming)
(docs release 1.52.0; RunEvent schema pinned to `1-0-5`):

- **ADLS Gen2 / Blob** → the canonical identity is
  `abfss://{container}@{account}.dfs.{suffix}/{path}`. `wasbs`/`abfs`/`https`
  dfs+blob spellings all fold in (one storage account + container + path is one
  dataset), `_delta_log` / `_spark_metadata` / part-file leaves fold onto the
  table folder, and the identity is case-folded. Sovereign suffixes are carried
  through, never assumed. OneLake deliberately opts OUT — it keeps its
  pre-existing raw `path:` key rather than having a container fabricated out of a
  Fabric workspace GUID.
- **Synapse / SQL** → the identity **persisted on the thread edge** is the bare
  3-part `{database}.{schema}.{table}` (`canonicalDatasetIdentity()`), reduced
  from a `sqlserver://{host}:{port}/…` dataset URI. That is the only spelling
  `normalizeIdentity` turns into a `uc:` key, so a SQL relation collapses onto
  the node the Unity Catalog overlay and the dbt L6 parser
  (`physicalRelation()`, identical 3-part form) contribute. Persisting the full
  `sqlserver://…` URI instead — as the first cut of LU-8 did — yields a node that
  normalizes to itself and joins to nothing.

The module is the READ/IDENTITY half only. The OpenLineage dataset *builders* a
Loom-side emitter needs (`storageDataset`, `sqlDataset`,
`adfLocationToStorageUri`) arrive with the emitters that call them, rather than
being parked here with no caller.

### Security properties of a dataset identity

A dataset identity is **persisted** (thread edge, graph node id) and **rendered**
(canvas node label), so it is treated as untrusted input:

- `stripUriCredentials()` removes, before parsing: the query string (SAS
  `?sv=…&sig=…`) and fragment; URI userinfo (`https://user:pass@acct…`);
  abfss/wasbs authority userinfo that is **not a legal container name**; and a
  malformed `host:<non-numeric>` tail.
  The last two matter more than they look. A SAS does not have to arrive after a
  `?`: `abfss://sv=…&sig=SECRET@acct.dfs…` and `abfss://c@acct:SECRET.dfs…` both
  put credential material where the charset checks (`CONTAINER_RE` /
  `ACCOUNT_RE`) only *rejected the parse* — and `canonicalStorageUri` then fell
  through to its non-Azure passthrough, which returns the whole string, signature
  included, as the persisted identity. The charset checks moved those leaks
  rather than stopping them. Stripping in `stripUriCredentials` stops them, and
  the passthrough is safe by construction.
  Stated honestly: `CONTAINER_RE` **is** load-bearing (it is the abfss userinfo
  oracle — mutating it to `/^.*$/` turns three specs red); `ACCOUNT_RE` is **not**
  a credential defense and never was — it is a well-formedness check that keeps a
  malformed authority out of the canonical `abfss://{container}@{account}` shape.
- An item's stored state path is canonicalized **without** the table-folder fold
  (`{ fold: false }`): folding an ownership CLAIM widens it to the parent folder,
  and a resolved local owner suppresses the cross-workspace forgery probe, so a
  widened claim turns a would-be 403 into an allow. An OBSERVED dataset URI still
  folds (the direction the `_delta_log` join needs), and `resolveOwner` matches an
  observation both folded and literal so an item whose root genuinely ends in
  `part-…` can still resolve itself.
- The denial audit strips too. `auditCrossWorkspaceDenial` canonicalizes the URI
  it writes to the Cosmos audit `target` and the SIEM stream **inside the
  function**, not only at its callers — the audit log is a durable store exactly
  like the thread edge, and one producer forgetting to strip is how the first
  remediation left the ingest route leaking after the harvests were fixed.

### Denial of service — the parse path is index-based

Every function above runs on dataset names lifted straight out of a 5 MB
attacker-controlled `POST /api/lineage/openlineage` body, so a quadratic regex
here is a reachable DoS, not a lint nit. `trimSlashes` / `trimTrailingSlashes` /
`trimLeadingSlashes` (charCode scans), `hasUriScheme` / `splitUri`
(`indexOf('://')`, with the only surviving regex applied to a scheme slice capped
at 32 chars), `stripMalformedPort` (`lastIndexOf(':')` + digit check) and
`parseStorageUri` (split on `://`, `@`, `.`) replace the regex forms.

Measured, per field, on one core, before the rewrite:

| slash-run length in `namespace` | time |
| --- | --- |
| 20 000 | 219 ms |
| 50 000 | 1 357 ms |
| 100 000 | 6 362 ms |
| 200 000 | 28 743 ms |

`/\/+$/` is quadratic only when the slash run is followed by a NON-slash tail
(that forces `/+` to retry from every position) — i.e. exactly what a dataset
name like `abfss://c@a.dfs…/x/////…////part-0` looks like. `namespace` has no
length cap in `parseRunEvent` (only `name`, `run.runId` and `job.name` do) and
`OL_MAX_DATASETS` is 50, so the end-to-end number is the one that matters:
`mapRunEventToEdges` over 50 hostile datasets took **209 032 ms** with the regex
restored — 3.5 minutes of event-loop time on a shared console replica, bought by
ONE request that is inside every declared limit (under the 5 MB body cap, at the
fan-out cap, one rate-limit token). Both figures are the recorded output of the
mutation run in `lineage-security-r3.test.ts`, not estimates.

**Correction to the record.** Commit `bc267d6d` ("kill the polynomial ReDoS on
the OpenLineage ingest path") fixed `dataset-naming` and `unified-lineage` — the
two modules CodeQL had flagged — and MISSED `openlineage-ingest.datasetUri()`,
which runs BEFORE either of them on every dataset in the body and still ran
`namespace.replace(/\/+$/, '')`. CodeQL never flagged that call site, so
"alerts 7 to 0" was true and irrelevant. It is fixed here, and `dataset-naming`
now owns the only slash-trimming primitives on this path so no future edit to the
ingest module can reintroduce the regex form.

### Three joins repaired

1. `POST /api/lineage/openlineage` matched dataset URIs against item state paths
   **verbatim** — an item whose `state.adlsRoot` held the `https://…` spelling
   could never be matched by a Spark event, so those events were silently
   skipped. Both sides are now canonicalized
   (`lib/lineage/dataset-item-resolver.ts`, extracted from the route so every
   producer shares one answer to "which item owns this path?").
2. Weave/thread-edge endpoints only carried an `item:<id>` identity, so an edge
   recorded against a physical path or a `catalog.schema.table` relation (the dbt
   L6 parser today, the Synapse emitters next) could never collapse onto the
   Purview / Unity Catalog node for the same asset.
3. The Purview overlay derived its join key from `displayText` (usually just the
   leaf name) and ignored the Atlas **qualifiedName** — the actual FQN.
## MIG1 note (Cosmos doc shapes)

No migration required: `ThreadEdge.columnMappings` is **additive** and shipped
in L1 (#2403) — pre-existing table-grain edges keep their exact stored shape
(the field is only persisted when present), and `migrateOnRead` has nothing to
upgrade. L2 only writes NEW edges in the L1 shape.

## Verification

- Unit (LU-8a): `lib/lineage/__tests__/dataset-naming.test.ts` — spelling
  equivalences AND the deliberate non-equivalences (different account /
  container / path, and `sales` vs `sales_archive`), plus what
  `canonicalDatasetIdentity` persists.
- Attack (LU-8a): `lib/lineage/__tests__/lineage-ingest-security.test.ts` —
  every case asserts a DENIAL: a SAS or userinfo reaching no persisted identity
  and no rendered node id on the Azure path, the non-Azure passthrough and the
  `{namespace, name}` join; a folded ownership CLAIM failing to swallow siblings;
  the cross-workspace probe firing across the https/abfss spelling mismatch and
  NOT firing on a prefix look-alike; OneLake keeping its own key.
  `lineage-security-r3.test.ts` carries the mutation-named credential-strip cases
  and the hostile-input budget guards (including
  `openlineage-ingest.datasetUri`), and
  `app/api/lineage/openlineage/__tests__/denial-audit-strip.test.ts` drives the
  real route end-to-end and asserts neither the Cosmos audit row nor the SIEM
  event carries the signature.
- Unit: `lib/azure/__tests__/openlineage-ingest.test.ts` (golden RunEvent →
  declared column mappings; fan-out caps) and
  `lib/azure/__tests__/openlineage-auth.test.ts` (real-RS256 accept path;
  expired / foreign-tenant / bad-audience / forged-signature / unregistered-
  principal rejections; workspace-token binding + fail-closed).
- Post-roll live receipt (orchestrator): POST the golden fixture with a minted
  workspace token against the live in-VNet route → `200 {ok:true, accepted…}`,
  then read the edges back via `GET /api/catalog/lineage?…&columns=true`; a
  curl from OUTSIDE the VNet (public FD host) must NOT reach the route.
